interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

export interface EmailDelivery {
  sendVerification(input: {
    email: string;
    displayName: string;
    verificationUrl: string;
    idempotencyKey: string;
  }): Promise<void>;
  sendPasswordReset(input: {
    email: string;
    displayName: string;
    resetUrl: string;
    idempotencyKey: string;
  }): Promise<void>;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function emailHtml(input: {
  preview: string;
  heading: string;
  greeting: string;
  body: string;
  buttonLabel: string;
  url: string;
  expiry: string;
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(input.preview)}</title>
  </head>
  <body>
    <p>${escapeHtml(input.greeting)}</p>
    <h1>${escapeHtml(input.heading)}</h1>
    <p>${escapeHtml(input.body)}</p>
    <p><a href="${escapeHtml(input.url)}">${escapeHtml(input.buttonLabel)}</a></p>
    <p>${escapeHtml(input.expiry)}</p>
    <p>If you did not request this, you can safely ignore this email.</p>
  </body>
</html>`;
}

export class ResendEmailService implements EmailDelivery {
  private constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  static fromEnvironment(): ResendEmailService | null {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    const from = process.env.EMAIL_FROM?.trim();
    if (!apiKey && !from) return null;
    if (!apiKey || !from) {
      throw new Error('RESEND_API_KEY and EMAIL_FROM must be configured together.');
    }
    return new ResendEmailService(apiKey, from);
  }

  async sendVerification(input: {
    email: string;
    displayName: string;
    verificationUrl: string;
    idempotencyKey: string;
  }): Promise<void> {
    const greeting = `Hello ${input.displayName},`;
    await this.send({
      to: input.email,
      subject: 'Verify your Ruffl email',
      text: `${greeting}\n\nVerify your email by opening this link:\n${input.verificationUrl}\n\nThis link expires in 24 hours. If you did not create a Ruffl account, you can ignore this email.`,
      html: emailHtml({
        preview: 'Verify your Ruffl email',
        heading: 'Verify your email',
        greeting,
        body: 'Confirm that this email address belongs to your Ruffl account.',
        buttonLabel: 'Verify email',
        url: input.verificationUrl,
        expiry: 'This link expires in 24 hours.',
      }),
      idempotencyKey: input.idempotencyKey,
    });
  }

  async sendPasswordReset(input: {
    email: string;
    displayName: string;
    resetUrl: string;
    idempotencyKey: string;
  }): Promise<void> {
    const greeting = `Hello ${input.displayName},`;
    await this.send({
      to: input.email,
      subject: 'Reset your Ruffl password',
      text: `${greeting}\n\nReset your password by opening this link:\n${input.resetUrl}\n\nThis link expires in 30 minutes. If you did not request a password reset, you can ignore this email.`,
      html: emailHtml({
        preview: 'Reset your Ruffl password',
        heading: 'Reset your password',
        greeting,
        body: 'Use the secure Ruffl page below to choose a new password.',
        buttonLabel: 'Reset password',
        url: input.resetUrl,
        expiry: 'This link expires in 30 minutes and stops working after a successful reset.',
      }),
      idempotencyKey: input.idempotencyKey,
    });
  }

  private async send(message: EmailMessage): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': message.idempotencyKey,
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Email delivery failed with status ${response.status}.`);
    }
  }
}
