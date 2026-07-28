/* eslint no-console: 0 */

'use strict';

import * as nodemailer from 'nodemailer'

/**
 * Sends an email with the reconciliation summary.
 * @param content The text content of the email.
 * @param imgFileName Optional image file name to attach.
 */
export async function sendEmail(
    content: string, 
    imgFileName?: string,
    subject: string = 'Up Bank Reconciliation',
    title: string = 'Reconciliation Summary'
) {
    // Create a SMTP transporter object
    // Using Gmail SMTP service
    let transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });

    const options: Intl.DateTimeFormatOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const today = new Date();

    // Message object
    if (!process.env.EMAIL_TO) {
        console.error('EMAIL_TO environment variable is not set. Skipping email notification.');
        return;
    }

    let message: any = {
        from: process.env.EMAIL_FROM || 'Actual Budget Bridge <bot@example.com>',
        to: process.env.EMAIL_TO,
        subject: `${subject} - ${today.toLocaleDateString("en-GB", options)}`,
        text: content,
        html: `
            <div style="font-family: sans-serif; line-height: 1.5;">
                <h2>${title}</h2>
                <pre style="background: #f4f4f4; padding: 15px; border-radius: 5px; white-space: pre-wrap;">
${content}
                </pre>
                ${imgFileName ? `<div><img src="cid:summary_img" style="max-width: 100%; margin-top: 20px;"/></div>` : ''}
            </div>`
    };

    if (imgFileName) {
        const filePath = (process.env.FILE_LOCATION || './') + imgFileName;
        message.attachments = [{
            filename: imgFileName,
            path: filePath,
            cid: 'summary_img'
        }];
    }

    try {
        let info = await transporter.sendMail(message);
        console.log('Email sent successfully: %s', info.messageId);
    } catch (error) {
        console.error('Failed to send email:', error);
        throw error;
    }
}

