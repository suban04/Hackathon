require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const Tesseract = require('tesseract.js');
const twilio = require('twilio');

const { pool, testConnection } = require('./config/database');
const AgentOrchestrator = require('./agents');
const { getTraceUrl } = require('./config/observability');
const PrescriptionValidator = require('./prescriptionValidator');

// Import NLP Service
const NLPService = require('./services/nlpService');

// Import Auto Refill Service
const AutoRefillService = require('./services/autoRefillService');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize NLP Service
const nlpService = new NLPService();

// Initialize Twilio (only if credentials are provided)
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    try {
        twilioClient = twilio(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_AUTH_TOKEN
        );
        console.log('✅ Twilio initialized');
    } catch (error) {
        console.error('❌ Twilio initialization failed:', error.message);
    }
} else {
    console.log('⚠️ Twilio credentials not found, SMS disabled');
}

// Initialize Agent Orchestrator
const orchestrator = new AgentOrchestrator();

// Initialize Prescription Validator
const prescriptionValidator = new PrescriptionValidator();

// Initialize Auto Refill Service
const autoRefillService = new AutoRefillService();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './uploads';
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const prefix = file.fieldname === 'prescription' ? 'prescription' : 'scan';
        cb(null, `${prefix}_${Date.now()}.jpg`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Ensure uploads directory exists
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads', { recursive: true });
}

// Test database connection on startup
testConnection();

// ==================== NLP INITIALIZATION ====================
// Load medicines into NLP on startup
async function initializeNLP() {
    try {
        const [medicines] = await pool.query('SELECT medicine_id, name FROM medicines');
        await nlpService.initializeMedicineDatabase(medicines);
        console.log('✅ NLP Service initialized with', medicines.length, 'medicines');
    } catch (error) {
        console.error('❌ Failed to initialize NLP:', error);
    }
}

// Initialize NLP after database connection
setTimeout(() => {
    initializeNLP();
}, 2000); // Give database time to connect

// ==================== AUTO-REFILL INITIALIZATION ====================
// Start auto-refill service (checks every 24 hours by default)
if (process.env.ENABLE_AUTO_REFILL === 'true') {
    const refillInterval = parseInt(process.env.REFILL_CHECK_INTERVAL) || 24;
    autoRefillService.start(refillInterval);
    console.log(`🤖 Auto Refill Service: Active (checks every ${refillInterval} hours)`);
} else {
    console.log('🤖 Auto Refill Service: Disabled (set ENABLE_AUTO_REFILL=true to enable)');
}

// ==================== API ENDPOINTS ====================

// Get all medicines from database
app.get('/api/medicines', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM medicines ORDER BY name');
        res.json({
            success: true,
            count: rows.length,
            medicines: rows
        });
    } catch (error) {
        console.error('Error fetching medicines:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Get medicine by ID
app.get('/api/medicines/:id', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM medicines WHERE medicine_id = ?',
            [req.params.id]
        );
        
        if (rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Medicine not found' 
            });
        }
        
        res.json({
            success: true,
            medicine: rows[0]
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== NLP ENDPOINTS ====================

// Spell checking and suggestions endpoint
app.post('/api/spell-check', async (req, res) => {
    try {
        const { text } = req.body;
        
        // Check if the medicine name might be misspelled
        const medicine = nlpService.extractMedicineName(text);
        const suggestions = nlpService.suggestCorrections(text);
        
        res.json({
            original: text,
            detectedMedicine: medicine,
            suggestions: suggestions,
            message: medicine ? 'Medicine detected' : 'No exact match found'
        });
        
    } catch (error) {
        console.error('Spell check error:', error);
        res.status(500).json({ 
            error: error.message,
            suggestions: [] 
        });
    }
});

// NLP endpoint for message processing
app.post('/api/process-message', async (req, res) => {
    try {
        const { message, state, sessionId } = req.body;
        
        // Process message with NLP
        const intent = nlpService.extractIntent(message);
        const action = nlpService.processUserMessage(message, state);
        
        res.json({
            ...action,
            intent,
            extractedMedicine: intent.MEDICINE
        });
        
    } catch (error) {
        console.error('NLP processing error:', error);
        res.status(500).json({ 
            action: 'processNormally',
            error: error.message 
        });
    }
});

// Extract medicine name endpoint
app.post('/api/extract-medicine', async (req, res) => {
    try {
        const { message } = req.body;
        const medicine = nlpService.extractMedicineName(message);
        
        res.json({ 
            success: !!medicine,
            medicine: medicine || null,
            message: medicine ? 'Medicine extracted' : 'No medicine found'
        });
        
    } catch (error) {
        console.error('Medicine extraction error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Check stock endpoint - WITH PRESCRIPTION INFO
app.post('/api/check-stock', async (req, res) => {
    const { medicine } = req.body;
    
    try {
        const [rows] = await pool.query(
            `SELECT * FROM medicines 
             WHERE LOWER(name) LIKE ? OR LOWER(name) = ?`,
            [`%${medicine.toLowerCase()}%`, medicine.toLowerCase()]
        );
        
        if (rows.length === 0) {
            return res.json({
                available: false,
                message: 'Medicine not found in database'
            });
        }
        
        const med = rows[0];
        res.json({
            available: med.stock > 0,
            medicineId: med.medicine_id,
            name: med.name,
            price: med.selling_price,
            stock: med.stock,
            manufacturer: med.manufacturer,
            expiry: med.expiry_date,
            category: med.category,
            prescriptionRequired: med.prescription_req === 1 || med.prescription_req === true,
            refillFrequencyDays: med.refill_frequency_days || 30
        });
        
    } catch (error) {
        res.status(500).json({ 
            available: false, 
            error: error.message 
        });
    }
});

// Scan medicine endpoint
app.post('/api/scan-medicine', upload.single('image'), async (req, res) => {
    let imagePath = null;
    
    try {
        // Handle different input types
        if (req.file) {
            imagePath = req.file.path;
            console.log('📸 Processing scan:', req.file.filename);
        } else if (req.body && req.body.image) {
            const base64Data = req.body.image.replace(/^data:image\/\w+;base64,/, '');
            imagePath = `uploads/scan_${Date.now()}.jpg`;
            fs.writeFileSync(imagePath, base64Data, 'base64');
        } else {
            return res.status(400).json({ error: 'No image provided' });
        }

        // Perform OCR
        console.log('🔍 Running OCR...');
        const { data: { text } } = await Tesseract.recognize(
            imagePath,
            'eng',
            {
                logger: m => {
                    if (m.status === 'recognizing text') {
                        console.log(`OCR Progress: ${Math.round(m.progress * 100)}%`);
                    }
                }
            }
        );

        // Clean up temp file
        try { fs.unlinkSync(imagePath); } catch (e) {}

        // Extract medicine name from OCR text
        const extractedText = text.toLowerCase();
        console.log('📝 Extracted text:', extractedText.substring(0, 200));

        // Search in database
        const words = extractedText.split(/\s+/).filter(w => w.length > 3);
        
        let detectedMedicine = null;
        
        for (const word of words) {
            const [rows] = await pool.query(
                `SELECT * FROM medicines 
                 WHERE LOWER(name) LIKE ? OR LOWER(name) = ?`,
                [`%${word}%`, word]
            );
            
            if (rows.length > 0) {
                detectedMedicine = rows[0];
                break;
            }
        }

        if (detectedMedicine) {
            res.json({
                success: true,
                medicine: detectedMedicine.name,
                details: {
                    name: detectedMedicine.name,
                    available: detectedMedicine.stock > 0,
                    price: detectedMedicine.selling_price,
                    stock: detectedMedicine.stock,
                    manufacturer: detectedMedicine.manufacturer,
                    composition: detectedMedicine.category,
                    expiry: detectedMedicine.expiry_date,
                    prescriptionRequired: detectedMedicine.prescription_req === 1 || detectedMedicine.prescription_req === true,
                    refillFrequencyDays: detectedMedicine.refill_frequency_days || 30
                },
                extractedText: extractedText.substring(0, 100)
            });
        } else {
            res.json({
                success: false,
                message: 'No medicine detected. Please try again with clearer image.'
            });
        }

    } catch (error) {
        console.error('Scan error:', error);
        if (imagePath && fs.existsSync(imagePath)) {
            try { fs.unlinkSync(imagePath); } catch (e) {}
        }
        res.status(500).json({ error: error.message });
    }
});

// Validate prescription endpoint
app.post('/api/validate-prescription', upload.single('prescription'), async (req, res) => {
    let imagePath = null;
    
    try {
        if (req.file) {
            imagePath = req.file.path;
            console.log('📄 Processing prescription:', req.file.filename);
        } else if (req.body && req.body.image) {
            const base64Data = req.body.image.replace(/^data:image\/\w+;base64,/, '');
            imagePath = `uploads/prescription_${Date.now()}.jpg`;
            fs.writeFileSync(imagePath, base64Data, 'base64');
        } else {
            return res.status(400).json({ error: 'No prescription image provided' });
        }

        // Validate prescription
        const validationResult = await prescriptionValidator.validatePrescription(imagePath, req.body.medicineName);

        // Clean up temp file
        try { fs.unlinkSync(imagePath); } catch (e) {}

        res.json(validationResult);

    } catch (error) {
        console.error('Prescription validation error:', error);
        if (imagePath && fs.existsSync(imagePath)) {
            try { fs.unlinkSync(imagePath); } catch (e) {}
        }
        res.status(500).json({ 
            valid: false, 
            error: error.message,
            message: 'Error validating prescription'
        });
    }
});

// Helper function to ensure orders table exists
async function ensureOrdersTable() {
    try {
        const [tables] = await pool.query("SHOW TABLES LIKE 'orders'");
        
        if (tables.length === 0) {
            console.log('📊 Creating orders table on demand...');
            await pool.query(`
                CREATE TABLE orders (
                    order_id VARCHAR(50) PRIMARY KEY,
                    medicine_name VARCHAR(255) NOT NULL,
                    quantity INT NOT NULL,
                    price DECIMAL(10,2) NOT NULL,
                    total_amount DECIMAL(10,2) NOT NULL,
                    user_name VARCHAR(255) NOT NULL,
                    phone VARCHAR(20) NOT NULL,
                    address TEXT NOT NULL,
                    status VARCHAR(20) DEFAULT 'pending',
                    payment_status VARCHAR(20) DEFAULT 'pending',
                    prescription_verified BOOLEAN DEFAULT FALSE,
                    prescription_path VARCHAR(255),
                    agent_chain TEXT,
                    trace_id VARCHAR(100),
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
            console.log('✅ Orders table created successfully');
        }
    } catch (error) {
        console.error('❌ Failed to ensure orders table:', error.message);
    }
}

// Process order through agent system - WITH PRESCRIPTION HANDLING
app.post('/api/create-order', async (req, res) => {
    try {
        const orderData = req.body;
        const sessionId = req.headers['x-session-id'];
        
        console.log('📦 Processing order:', orderData);
        
        // Check if prescription is required and validated
        if (orderData.prescriptionRequired && !orderData.prescriptionValidated) {
            return res.status(400).json({
                success: false,
                message: 'Prescription validation required for this medicine',
                prescriptionRequired: true
            });
        }
        
        // Process through agent orchestrator
        const result = await orchestrator.processOrder(orderData, sessionId);
        
        if (result.success) {
            // Save order to database with better error handling
            try {
                // Check if orders table exists and create if needed
                await ensureOrdersTable();
                
                // Insert order
                await pool.query(
                    `INSERT INTO orders 
                     (order_id, medicine_name, quantity, price, total_amount, 
                      user_name, phone, address, status, payment_status, 
                      prescription_verified, agent_chain, trace_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        result.orderId,
                        result.medicine,
                        result.quantity,
                        orderData.price,
                        result.totalAmount,
                        orderData.userName,
                        orderData.phone,
                        orderData.address,
                        'approved',
                        'completed',
                        orderData.prescriptionValidated || false,
                        JSON.stringify(result.chainOfThought || []),
                        result.traceId
                    ]
                );
                
                console.log('✅ Order saved to database:', result.orderId);
            } catch (dbError) {
                console.error('❌ Database error saving order:', dbError.message);
                // Continue even if DB save fails - order is still processed
            }
            
            // Send SMS confirmation if Twilio is configured
            if (twilioClient) {
                try {
                    // Create a concise SMS message (trial accounts have length limits)
                    let smsMessage = `PharmacyAI Order: ${result.orderId}\n`;
                    smsMessage += `${result.medicine} x${result.quantity} = ₹${result.totalAmount}\n`;
                    if (orderData.prescriptionValidated) {
                        smsMessage += `Prescription: Verified\n`;
                    }
                    smsMessage += `Thank you!`;
                    
                    // Try to send SMS but don't fail the order if it doesn't work
                    await sendOrderConfirmationSMS(orderData.phone, smsMessage).catch(err => {
                        console.error('SMS sending failed but order was created:', err.message);
                    });
                    
                } catch (smsError) {
                    console.error('SMS sending error:', smsError);
                    // Don't fail the order - just log the error
                }
            } else {
                console.log('📱 SMS not sent - Twilio not configured');
            }
            
            // Update inventory
            try {
                await pool.query(
                    `UPDATE medicines 
                     SET stock = stock - ? 
                     WHERE LOWER(name) = ?`,
                    [result.quantity, result.medicine.toLowerCase()]
                );
                console.log('✅ Inventory updated');
            } catch (invError) {
                console.error('❌ Inventory update failed:', invError.message);
            }
        }
        
        // Include trace URL for observability
        const traceUrl = getTraceUrl(result.traceId);
        
        res.json({
            ...result,
            traceUrl
        });
        
    } catch (error) {
        console.error('❌ Order creation error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            message: 'Failed to create order. Please try again.'
        });
    }
});

// Send SMS function - MODIFIED for Twilio trial account
async function sendOrderConfirmationSMS(phone, message) {
    try {
        // Check if Twilio client is initialized
        if (!twilioClient) {
            console.log('📱 SMS not sent - Twilio not configured');
            return;
        }

        // Format phone number (add + if not present)
        let formattedPhone = phone;
        if (!formattedPhone.startsWith('+')) {
            // Assume Indian numbers if not specified
            if (formattedPhone.length === 10) {
                formattedPhone = `+91${formattedPhone}`;
            } else {
                formattedPhone = `+${formattedPhone}`;
            }
        }
        
        console.log(`📱 Attempting to send SMS to ${formattedPhone}`);
        
        // Truncate message if too long (Twilio trial accounts have limits)
        const maxLength = 160; // Standard SMS length
        let finalMessage = message;
        if (message.length > maxLength) {
            finalMessage = message.substring(0, maxLength - 20) + '... Order confirmed';
            console.log(`📱 Message truncated from ${message.length} to ${finalMessage.length} chars`);
        }
        
        // Check if this is a verified number (for trial accounts)
        const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
        if (!twilioPhoneNumber) {
            console.error('❌ TWILIO_PHONE_NUMBER not set in .env');
            return;
        }
        
        // For trial accounts, you need to add the recipient number in Twilio console
        console.log(`📱 Sending from: ${twilioPhoneNumber} to: ${formattedPhone}`);
        
        const smsMessage = await twilioClient.messages.create({
            body: finalMessage,
            from: twilioPhoneNumber,
            to: formattedPhone
        });
        
        console.log(`✅ SMS sent successfully to ${formattedPhone}: ${smsMessage.sid}`);
        return smsMessage;
        
    } catch (error) {
        // Handle specific Twilio errors
        if (error.code === 21608) {
            console.error('❌ Twilio trial account error: The phone number is not verified.');
            console.error('   Add this number in your Twilio console: https://console.twilio.com');
        } else if (error.code === 21408) {
            console.error('❌ Twilio error: Message length exceeded trial limit.');
        } else if (error.code === 21211) {
            console.error('❌ Twilio error: Invalid phone number format.');
        } else {
            console.error('❌ Twilio error:', error.message);
        }
        throw error; // Re-throw for handling in the calling function
    }
}

// Get order trace (for observability)
app.get('/api/order-trace/:orderId', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM orders WHERE order_id = ?',
            [req.params.orderId]
        );
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        const order = rows[0];
        const trace = {
            orderId: order.order_id,
            status: order.status,
            paymentStatus: order.payment_status,
            prescriptionVerified: order.prescription_verified,
            agentChain: JSON.parse(order.agent_chain || '[]'),
            traceId: order.trace_id,
            traceUrl: getTraceUrl(order.trace_id)
        };
        
        res.json(trace);
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get sales report
app.get('/api/sales-report', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                s.sale_id,
                s.quantity,
                s.sale_date,
                m.name as medicine_name,
                m.selling_price,
                (s.quantity * m.selling_price) as total_amount
            FROM sales s
            JOIN medicines m ON s.medicine_id = m.medicine_id
            ORDER BY s.sale_date DESC
            LIMIT 100
        `);
        
        res.json({
            success: true,
            count: rows.length,
            sales: rows
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create orders table manually endpoint (for debugging)
app.get('/api/create-orders-table', async (req, res) => {
    try {
        await ensureOrdersTable();
        
        res.json({ 
            success: true, 
            message: 'Orders table created successfully' 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ==================== AUTO-REFILL ENDPOINTS ====================

// Manually trigger refill check (admin only - you should add auth in production)
app.post('/api/admin/trigger-refill-check', async (req, res) => {
    try {
        await autoRefillService.checkAndSendRefillReminders();
        res.json({
            success: true,
            message: 'Refill check triggered successfully'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get refill reminders statistics
app.get('/api/refill-stats', async (req, res) => {
    try {
        const stats = await autoRefillService.getRefillStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Analyze customer purchase patterns
app.post('/api/analyze-customer/:phone', async (req, res) => {
    try {
        const analysis = await autoRefillService.analyzeCustomerPatterns(req.params.phone);
        res.json(analysis);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get all refill reminders for a customer
app.get('/api/customer-refills/:phone', async (req, res) => {
    try {
        const [reminders] = await pool.query(`
            SELECT * FROM refill_reminders 
            WHERE phone = ? 
            ORDER BY sent_at DESC
        `, [req.params.phone]);
        
        res.json({
            success: true,
            count: reminders.length,
            reminders: reminders
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Mark refill as responded
app.post('/api/refill-responded/:id', async (req, res) => {
    try {
        await pool.query(`
            UPDATE refill_reminders 
            SET responded = TRUE 
            WHERE id = ?
        `, [req.params.id]);
        
        res.json({
            success: true,
            message: 'Refill marked as responded'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Add refill frequency to medicine
app.post('/api/medicine/:id/set-refill-frequency', async (req, res) => {
    try {
        const { frequency } = req.body;
        
        // First check if column exists
        try {
            await pool.query(`
                ALTER TABLE medicines 
                ADD COLUMN IF NOT EXISTS refill_frequency_days INT DEFAULT 30
            `);
        } catch (alterError) {
            // Column might already exist, ignore error
            console.log('Note:', alterError.message);
        }
        
        await pool.query(`
            UPDATE medicines 
            SET refill_frequency_days = ? 
            WHERE medicine_id = ?
        `, [frequency, req.params.id]);
        
        res.json({
            success: true,
            message: 'Refill frequency updated successfully'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Health check - UPDATED with auto-refill status
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        
        // Check if orders table exists
        const [tables] = await pool.query("SHOW TABLES LIKE 'orders'");
        const [refillTables] = await pool.query("SHOW TABLES LIKE 'refill_reminders'");
        
        res.json({ 
            status: 'healthy',
            database: 'connected',
            nlp: nlpService && nlpService.medicineNames ? 'loaded' : 'initializing',
            medicinesCount: nlpService?.medicineNames?.length || 0,
            ordersTable: tables.length > 0 ? 'exists' : 'missing',
            refillTable: refillTables.length > 0 ? 'exists' : 'missing',
            twilio: twilioClient ? 'configured' : 'not configured',
            autoRefill: autoRefillService.isRunning ? 'active' : 'inactive',
            prescriptionValidator: 'active',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'unhealthy',
            database: 'disconnected',
            error: error.message
        });
    }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(60));
    console.log(`🚀 Pharmacy AI Agentic System`);
    console.log('='.repeat(60));
    console.log(`📱 Server: http://localhost:${PORT}`);
    console.log(`💊 Database: ${process.env.DB_HOST || 'localhost'}/${process.env.DB_NAME || 'pharmacy_db'}`);
    console.log(`🤖 Multi-Agent System: Active`);
    console.log(`📋 Prescription Validation: Active`);
    console.log(`🔤 NLP Spell Check: Active`);
    console.log(`🤖 Auto Refill Service: ${process.env.ENABLE_AUTO_REFILL === 'true' ? 'Active' : 'Disabled'}`);
    console.log(`🧠 LLM Integration: ${process.env.OPENAI_API_KEY ? 'Connected' : 'Not Configured'}`);
    console.log(`📊 Observability: ${process.env.LANGFUSE_PUBLIC_KEY ? 'Langfuse' : 'Mock Mode'}`);
    console.log(`📱 SMS: ${twilioClient ? 'Enabled' : 'Disabled'}`);
    console.log('='.repeat(60) + '\n');
    
    // Don't create table here - it will be created on demand
    console.log('📊 Orders table will be created on first order if needed');
    console.log('📊 Refill reminders table will be created on first reminder if needed');
});