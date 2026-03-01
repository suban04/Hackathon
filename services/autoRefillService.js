const { pool } = require('../config/database');
const LLMService = require('./llmService');
const twilio = require('twilio');

class AutoRefillService {
    constructor() {
        this.llmService = new LLMService();
        this.twilioClient = null;
        this.initializeTwilio();
        this.isRunning = false;
        this.checkInterval = null;
    }

    initializeTwilio() {
        try {
            if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
                this.twilioClient = twilio(
                    process.env.TWILIO_ACCOUNT_SID,
                    process.env.TWILIO_AUTH_TOKEN
                );
                console.log('✅ AutoRefill: Twilio initialized');
            }
        } catch (error) {
            console.error('❌ AutoRefill: Twilio initialization failed:', error.message);
        }
    }

    // Start the auto-refill service
    start(intervalHours = 24) {
        if (this.isRunning) {
            console.log('⚠️ AutoRefill service is already running');
            return;
        }

        console.log(`🚀 Starting AutoRefill service (checks every ${intervalHours} hours)`);
        this.isRunning = true;
        
        // Run immediately on start
        this.checkAndSendRefillReminders();
        
        // Then run at specified interval
        this.checkInterval = setInterval(
            () => this.checkAndSendRefillReminders(),
            intervalHours * 60 * 60 * 1000
        );
    }

    // Stop the auto-refill service
    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        this.isRunning = false;
        console.log('🛑 AutoRefill service stopped');
    }

    // Main function to check and send refill reminders
    async checkAndSendRefillReminders() {
        console.log(`\n🔍 AutoRefill: Checking for refill opportunities at ${new Date().toISOString()}`);
        
        try {
            // Get all customers with their purchase history
            const customers = await this.getCustomersForRefill();
            
            if (customers.length === 0) {
                console.log('📭 No customers need refill reminders at this time');
                return;
            }

            console.log(`📊 Found ${customers.length} customers who might need refills`);

            // Process each customer
            for (const customer of customers) {
                await this.processCustomerRefill(customer);
                
                // Add small delay between SMS sends to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

        } catch (error) {
            console.error('❌ AutoRefill check error:', error.message);
        }
    }

    // Get customers who might need refills
    async getCustomersForRefill() {
        try {
            // Get all customers with their last purchase dates
            const [customers] = await pool.query(`
                SELECT 
                    o.user_name,
                    o.phone,
                    o.medicine_name,
                    MAX(o.created_at) as last_purchase_date,
                    COUNT(*) as total_purchases,
                    AVG(m.refill_frequency_days) as avg_refill_frequency
                FROM orders o
                JOIN medicines m ON LOWER(o.medicine_name) = LOWER(m.name)
                WHERE o.status = 'approved'
                GROUP BY o.phone, o.medicine_name
                HAVING total_purchases >= 2
                ORDER BY last_purchase_date DESC
            `);

            const customersNeedingRefill = [];

            for (const customer of customers) {
                const lastPurchase = new Date(customer.last_purchase_date);
                const today = new Date();
                const daysSinceLastPurchase = Math.floor((today - lastPurchase) / (1000 * 60 * 60 * 24));
                
                // Calculate refill frequency (default to 30 days if not set)
                const refillFrequency = customer.avg_refill_frequency || 30;
                const daysUntilRefill = refillFrequency - daysSinceLastPurchase;
                
                // If within 1 day of needing refill (or overdue)
                if (daysUntilRefill <= 1) {
                    customersNeedingRefill.push({
                        customerName: customer.user_name,
                        phone: customer.phone,
                        medicineName: customer.medicine_name,
                        lastPurchaseDate: customer.last_purchase_date,
                        daysSinceLastPurchase,
                        daysUntilRefill,
                        totalPurchases: customer.total_purchases
                    });
                }
            }

            return customersNeedingRefill;

        } catch (error) {
            console.error('❌ Error getting customers for refill:', error.message);
            return [];
        }
    }

    // Process refill for a single customer using LLM
    async processCustomerRefill(customerData) {
        try {
            console.log(`💊 Processing refill for ${customerData.customerName} - ${customerData.medicineName}`);

            // Get customer's full purchase history for better LLM context
            const [purchaseHistory] = await pool.query(`
                SELECT 
                    medicine_name,
                    quantity,
                    created_at,
                    total_amount
                FROM orders 
                WHERE phone = ? AND medicine_name = ? AND status = 'approved'
                ORDER BY created_at DESC
                LIMIT 10
            `, [customerData.phone, customerData.medicineName]);

            // Use LLM to generate personalized reminder
            const reminderData = await this.llmService.generateRefillReminder({
                customerName: customerData.customerName,
                medicineName: customerData.medicineName,
                daysUntilRefill: customerData.daysUntilRefill,
                lastPurchaseDate: customerData.lastPurchaseDate,
                phone: customerData.phone,
                purchaseHistory: purchaseHistory
            });

            // Send SMS reminder
            if (this.twilioClient && reminderData.success) {
                await this.sendRefillSMS(reminderData);
                
                // Log the reminder
                await this.logRefillReminder({
                    customerName: customerData.customerName,
                    phone: customerData.phone,
                    medicineName: customerData.medicineName,
                    message: reminderData.message,
                    generatedBy: reminderData.generatedBy,
                    daysUntilRefill: customerData.daysUntilRefill
                });

                console.log(`✅ Refill reminder sent to ${customerData.phone} using ${reminderData.generatedBy}`);
            } else {
                console.log(`⚠️ SMS not sent - Twilio not configured for ${customerData.phone}`);
            }

        } catch (error) {
            console.error(`❌ Error processing refill for ${customerData.customerName}:`, error.message);
        }
    }

    // Send SMS reminder
    async sendRefillSMS(reminderData) {
        try {
            if (!this.twilioClient) {
                console.log('📱 SMS not sent - Twilio not configured');
                return;
            }

            // Format phone number
            let formattedPhone = reminderData.customerPhone;
            if (!formattedPhone.startsWith('+')) {
                if (formattedPhone.length === 10) {
                    formattedPhone = `+91${formattedPhone}`;
                } else {
                    formattedPhone = `+${formattedPhone}`;
                }
            }

            // Create order link (you can generate actual link)
            const orderLink = `${process.env.APP_URL || 'http://localhost:3000'}/refill/${reminderData.medicineName}`;
            
            // Add link to message if not already present
            let finalMessage = reminderData.message;
            if (!finalMessage.includes('[link]') && !finalMessage.includes('http')) {
                finalMessage += ` Order here: ${orderLink}`;
            } else {
                finalMessage = finalMessage.replace('[link]', orderLink);
            }

            // Truncate if too long
            if (finalMessage.length > 160) {
                finalMessage = finalMessage.substring(0, 140) + '... Order now.';
            }

            const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
            if (!twilioPhoneNumber) {
                console.error('❌ TWILIO_PHONE_NUMBER not set');
                return;
            }

            const smsMessage = await this.twilioClient.messages.create({
                body: finalMessage,
                from: twilioPhoneNumber,
                to: formattedPhone
            });

            console.log(`✅ Refill SMS sent: ${smsMessage.sid}`);
            return smsMessage;

        } catch (error) {
            console.error('❌ Failed to send refill SMS:', error.message);
            throw error;
        }
    }

    // Log refill reminder to database
    async logRefillReminder(reminderData) {
        try {
            // Create refill_reminders table if it doesn't exist
            await this.ensureRemindersTable();

            await pool.query(`
                INSERT INTO refill_reminders 
                (customer_name, phone, medicine_name, message, generated_by, days_until_refill, sent_at)
                VALUES (?, ?, ?, ?, ?, ?, NOW())
            `, [
                reminderData.customerName,
                reminderData.phone,
                reminderData.medicineName,
                reminderData.message,
                reminderData.generatedBy,
                reminderData.daysUntilRefill
            ]);

            console.log(`📝 Refill reminder logged to database`);
        } catch (error) {
            console.error('❌ Failed to log refill reminder:', error.message);
        }
    }

    // Ensure refill_reminders table exists
    async ensureRemindersTable() {
        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS refill_reminders (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    customer_name VARCHAR(255) NOT NULL,
                    phone VARCHAR(20) NOT NULL,
                    medicine_name VARCHAR(255) NOT NULL,
                    message TEXT NOT NULL,
                    generated_by VARCHAR(50) DEFAULT 'LLM',
                    days_until_refill INT,
                    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    responded BOOLEAN DEFAULT FALSE,
                    INDEX idx_phone (phone),
                    INDEX idx_sent_at (sent_at)
                )
            `);
        } catch (error) {
            console.error('❌ Failed to create refill_reminders table:', error.message);
        }
    }

    // Analyze refill patterns for a customer
    async analyzeCustomerPatterns(phone) {
        try {
            const [orders] = await pool.query(`
                SELECT * FROM orders 
                WHERE phone = ? AND status = 'approved'
                ORDER BY created_at ASC
            `, [phone]);

            if (orders.length === 0) {
                return {
                    success: false,
                    message: 'No purchase history found'
                };
            }

            // Use LLM to analyze patterns
            const analysis = await this.llmService.analyzePurchaseHistory(orders);
            
            return {
                success: true,
                customer: orders[0].user_name,
                phone: phone,
                totalOrders: orders.length,
                analysis: analysis.analysis,
                generatedBy: analysis.generatedBy
            };

        } catch (error) {
            console.error('❌ Pattern analysis error:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Get statistics about refill reminders
    async getRefillStats() {
        try {
            const [stats] = await pool.query(`
                SELECT 
                    COUNT(*) as total_reminders,
                    COUNT(DISTINCT phone) as unique_customers,
                    COUNT(DISTINCT medicine_name) as unique_medicines,
                    SUM(CASE WHEN generated_by = 'LLM' THEN 1 ELSE 0 END) as llm_generated,
                    SUM(CASE WHEN generated_by = 'Template' THEN 1 ELSE 0 END) as template_generated,
                    DATE(sent_at) as date
                FROM refill_reminders
                GROUP BY DATE(sent_at)
                ORDER BY date DESC
                LIMIT 30
            `);

            return {
                success: true,
                stats: stats
            };

        } catch (error) {
            console.error('❌ Error getting refill stats:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

module.exports = AutoRefillService;