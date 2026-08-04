import { logger } from './logger';
import { UP_BANK_ACCOUNT_MAP } from './account-maps';
import { initializeActualProxy } from './actual-util';

let webhookQueue: Promise<any> = Promise.resolve();

export interface UpWebhookPayload {
    data: {
        type: string;
        id: string;
        attributes: {
            eventType: string;
            createdAt: string;
        };
        relationships: {
            transaction: {
                data: {
                    type: string;
                    id: string;
                };
            };
            webhook: {
                data: {
                    type: string;
                    id: string;
                };
            };
        };
    };
}

async function getTransactionDetails(transactionId: string) {
    const url = `https://api.up.com.au/api/v1/transactions/${transactionId}`;
    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${process.env.UPBANK_APIKEY}`
        }
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch transaction details: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data;
}

export async function handleUpWebhook(payload: UpWebhookPayload) {
    const task = webhookQueue.then(() => processWebhook(payload));
    webhookQueue = task.catch(() => {});
    return task;
}

async function processWebhook(payload: UpWebhookPayload) {
    logger.info(`Received Up Webhook: ${JSON.stringify(payload, null, 2)}`);

    if (payload.data.attributes.eventType === 'TRANSACTION_CREATED') {
        const transactionId = payload.data.relationships.transaction.data.id;
        logger.info(`[Up Bank] Transaction Created: ${transactionId}`);

        let actualProxy: any = null;

        try {
            // Initialize connection on demand
            actualProxy = await initializeActualProxy();

            const transactionDetails = await getTransactionDetails(transactionId);
            logger.info(`[Up Bank] Full Transaction Details: ${JSON.stringify(transactionDetails, null, 2)}`);

            const upAccountId = transactionDetails.data.relationships.account.data.id;
            const actualAccountId = UP_BANK_ACCOUNT_MAP[upAccountId];

            if (actualAccountId) {
                logger.info(`[Up Bank] Mapped Account ID: ${actualAccountId}`);

                const attributes = transactionDetails.data.attributes;
                const transaction = {
                    account: actualAccountId,
                    amount: attributes.amount.valueInBaseUnits,
                    date: attributes.createdAt.split('T')[0], // YYYY-MM-DD
                    payee_name: attributes.description,
                    imported_payee: attributes.rawText,
                    notes: attributes.message,
                    imported_id: transactionDetails.data.id,
                    cleared: true
                };

                logger.info(`[Up Bank] Importing transaction: ${JSON.stringify(transaction, null, 2)}`);

                const result = await actualProxy.importTransactions(actualAccountId, [transaction]);
                logger.info(`[Up Bank] Import Result: ${JSON.stringify(result, null, 2)}`);

                // Validation
                if (result && (result.added && result.added.length > 0 || result.updated && result.updated.length > 0)) {
                    logger.info(`[Up Bank] Transaction successfully imported.`);

                    // Sync changes to ensure they appear in the browser UI immediately
                    logger.info(`[Up Bank] Syncing changes to server...`);
                    await actualProxy.syncChanges();
                    logger.info(`[Up Bank] Sync completed.`);
                } else if (result && result.errors && result.errors.length > 0) {
                    logger.error(`[Up Bank] Error importing transaction: ${JSON.stringify(result.errors)}`);
                } else {
                    // It might be a duplicate or no changes were made
                    logger.warn(`[Up Bank] Transaction was not imported (likely duplicate or no changes). Result: ${JSON.stringify(result)}`);
                }

            } else {
                logger.warn(`[Up Bank] No mapping found for Up Account ID: ${upAccountId}`);
            }

        } catch (error) {
            logger.error(`[Up Bank] Error processing transaction:`, error);
        } finally {
            if (actualProxy) {
                try {
                    await actualProxy.shutdown();
                    logger.info('[Up Bank] Actual Proxy shutdown.');
                } catch (shutdownError) {
                    logger.error('[Up Bank] Error shutting down Actual Proxy:', shutdownError);
                }
            }
        }

        return transactionId;
    } else {
        logger.info(`[Up Bank] Unhandled event type: ${payload.data.attributes.eventType}`);
        return null;
    }
}
