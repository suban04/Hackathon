const OpenAI = require('openai');
require('dotenv').config();

class LLMService {
    constructor() {
        this.openai = null;
        this.initializeLLM();
    }

    initializeLLM() {
        try {
            // Initialize OpenAI (you can replace with any LLM provider)
            if (process.env.OPENAI_API_KEY) {
                this.openai = new OpenAI({
                    apiKey: process.env.OPENAI_API_KEY
                });
                console.log('✅ LLM Service initialized with OpenAI');
            } else {
                console.log('⚠️ OPENAI_API_KEY not found, LLM features disabled');
            }
        } catch (error) {
            console.error('❌ LLM initialization failed:', error.message);
        }
    }

    async generateRefillReminder(customerData) {
        try {
            if (!this.openai) {
                return this.getFallbackReminder(customerData);
            }

            const prompt = this.buildRefillPrompt(customerData);
            
            const completion = await this.openai.chat.completions.create({
                model: "gpt-3.5-turbo",
                messages: [
                    {
                        role: "system",
                        content: "You are a helpful pharmacy assistant that creates personalized, friendly SMS reminders for medicine refills. Keep messages concise (under 160 characters for SMS) and include the medicine name, customer name, and a gentle reminder to refill."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                max_tokens: 100,
                temperature: 0.7
            });

            const reminderMessage = completion.choices[0].message.content.trim();
            
            return {
                success: true,
                message: reminderMessage,
                customerPhone: customerData.phone,
                medicineName: customerData.medicineName,
                daysUntilRefill: customerData.daysUntilRefill,
                generatedBy: 'LLM'
            };

        } catch (error) {
            console.error('❌ LLM generation error:', error.message);
            // Fallback to template-based message
            return this.getFallbackReminder(customerData);
        }
    }

    async analyzePurchaseHistory(orders) {
        try {
            if (!this.openai || orders.length === 0) {
                return this.getFallbackAnalysis(orders);
            }

            const prompt = `
                Analyze this customer's medicine purchase history and identify patterns:
                
                Purchase History:
                ${JSON.stringify(orders, null, 2)}
                
                Please provide:
                1. List of medicines they regularly purchase
                2. Average time between refills for each medicine
                3. Any medicines that might need refill soon
                4. Brief analysis as JSON format
            `;

            const completion = await this.openai.chat.completions.create({
                model: "gpt-3.5-turbo",
                messages: [
                    {
                        role: "system",
                        content: "You are a pharmacy data analyst. Analyze purchase patterns and return structured JSON data about refill predictions."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                response_format: { type: "json_object" }
            });

            const analysis = JSON.parse(completion.choices[0].message.content);
            
            return {
                success: true,
                analysis: analysis,
                generatedBy: 'LLM'
            };

        } catch (error) {
            console.error('❌ Purchase history analysis error:', error.message);
            return this.getFallbackAnalysis(orders);
        }
    }

    buildRefillPrompt(customerData) {
        return `
            Create a friendly SMS reminder for medicine refill:
            
            Customer Name: ${customerData.customerName}
            Medicine: ${customerData.medicineName}
            Days until refill needed: ${customerData.daysUntilRefill}
            Previous Purchase Date: ${customerData.lastPurchaseDate || 'Not available'}
            
            The message should be:
            - Personal and caring
            - Include the medicine name
            - Gentle reminder to refill
            - Under 160 characters for SMS
            - Professional but warm tone
            
            Generate only the SMS message text, no additional explanation.
        `;
    }

    getFallbackReminder(customerData) {
        // Template-based fallback messages
        const templates = [
            `Hi ${customerData.customerName}, it's time to refill your ${customerData.medicineName}. Click here to order: [link]`,
            `Friendly reminder: Your ${customerData.medicineName} prescription may need refilling soon. Order now: [link]`,
            `Don't forget to refill your ${customerData.medicineName}. Stay healthy! Order here: [link]`
        ];
        
        const randomTemplate = templates[Math.floor(Math.random() * templates.length)];
        
        return {
            success: true,
            message: randomTemplate,
            customerPhone: customerData.phone,
            medicineName: customerData.medicineName,
            daysUntilRefill: customerData.daysUntilRefill,
            generatedBy: 'Template'
        };
    }

    getFallbackAnalysis(orders) {
        // Simple rule-based analysis
        const medicineFrequency = {};
        
        orders.forEach(order => {
            if (!medicineFrequency[order.medicine_name]) {
                medicineFrequency[order.medicine_name] = {
                    count: 0,
                    totalDays: 0,
                    lastPurchase: order.created_at
                };
            }
            medicineFrequency[order.medicine_name].count++;
            
            // Calculate average days between purchases (simplified)
            if (medicineFrequency[order.medicine_name].lastPurchase) {
                const lastDate = new Date(medicineFrequency[order.medicine_name].lastPurchase);
                const currentDate = new Date(order.created_at);
                const daysDiff = Math.abs(currentDate - lastDate) / (1000 * 60 * 60 * 24);
                medicineFrequency[order.medicine_name].totalDays += daysDiff;
            }
        });

        const regularMedicines = Object.entries(medicineFrequency)
            .filter(([_, data]) => data.count >= 2)
            .map(([medicine, data]) => ({
                medicine,
                frequency: data.count,
                avgDaysBetweenRefills: Math.round(data.totalDays / (data.count - 1)) || 30,
                lastPurchase: data.lastPurchase
            }));

        return {
            success: true,
            analysis: {
                regularMedicines,
                totalOrders: orders.length,
                generatedBy: 'Rule-based'
            }
        };
    }
}

module.exports = LLMService;