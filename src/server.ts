const express = require('express');
const crypto = require('crypto');
const actualProxy = require('./actual-util')
const path = require('path');
import * as upBankHandler from './up-bank-notification-handler'
import { logger } from './logger';

process.on('unhandledRejection', (reason, p) => {
    logger.error('Unhandled Rejection at:', p, 'reason:', reason);
});

const app = express();
const port = 8080

app.use(express.json({
    verify: (req: any, res, buf) => {
        req.rawBody = buf;
    }
}));

// Middleware to protect internal API endpoints
const authMiddleware = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    const internalApiKey = process.env.INTERNAL_API_KEY;

    if (!internalApiKey) {
        logger.error('INTERNAL_API_KEY is not set in the environment!');
        return res.status(500).json({ error: 'Internal Server Error: Security configuration missing' });
    }

    if (!apiKey || apiKey !== internalApiKey) {
        logger.warn(`Unauthorized access attempt to ${req.path} from ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing API Key' });
    }
    next();
};

app.get('/', (req, res) => {
    res.send("Actual Budget Bridge is Running")
});

app.post('/webhooks/up', async (req: any, res) => {
    try {
        const signature = req.headers['x-up-authenticity-signature'];
        const secret = process.env.UPBANK_WEBHOOK_SECRET;

        if (!secret) {
            logger.error('UPBANK_WEBHOOK_SECRET is not set in the environment!');
            return res.status(500).send('Internal Server Error');
        }

        if (!signature) {
            logger.warn(`Rejected Up Webhook: Missing signature header from ${req.ip}`);
            return res.status(401).send('Unauthorized');
        }

        const hmac = crypto.createHmac('sha256', secret);
        hmac.update(req.rawBody);
        const digest = hmac.digest('hex');

        if (signature !== digest) {
            logger.warn(`Rejected Up Webhook: Invalid signature from ${req.ip}`);
            return res.status(401).send('Unauthorized');
        }

        await upBankHandler.handleUpWebhook(req.body);
        res.status(200).send('OK');
    } catch (error) {
        logger.error('Error handling Up Bank webhook:', error);
        res.status(500).send('Internal Server Error');
    }
});

app.get('/api/data', authMiddleware, async (req, res) => {
    let proxy: any = null;
    try {
        proxy = await actualProxy.initializeActualProxy();
        const accounts = await proxy.getAccounts()
        logger.info(`accounts: ${JSON.stringify(accounts, null, 3)}`)
        res.status(200).send('{}')
        return
    } catch (error) {
        logger.error('Error in /api/data:', error);
        res.status(500).send('Internal Server Error');
    } finally {
        if (proxy) await proxy.shutdown();
    }
});

app.listen(port, () => {
    logger.info(`Server is running on port ${port}`);
});
