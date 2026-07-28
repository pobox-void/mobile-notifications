import { sendEmail } from '../email';
import * as dotenv from 'dotenv';
dotenv.config({ path: 'env/.env' });

const isSuccess = process.argv[2] === 'success';

async function main() {
    let content = process.argv.slice(3).join(' ');
    const subject = isSuccess ? '✅ Actual Budget Backup Success' : '❌ Actual Budget Backup FAILED';
    const title = isSuccess ? 'Backup Completed Successfully' : 'Backup Execution Failed';

    if (!content) {
        content = "No additional details provided.";
    }

    await sendEmail(content, undefined, subject, title);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
