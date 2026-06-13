import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'Privacy Policy for ALMA Lifestyle — how we handle customer data and Facebook Messenger communications.',
  robots: { index: true, follow: true },
}

const EFFECTIVE_DATE = '12 June 2026'

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-[100dvh] bg-zinc-50 text-zinc-900">
      <div className="mx-auto max-w-3xl px-6 py-12 sm:py-16">
        <header className="mb-10 border-b border-zinc-200 pb-8">
          <p className="text-sm font-medium uppercase tracking-wide text-zinc-500">ALMA Lifestyle</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-zinc-900 sm:text-4xl">
            Privacy Policy
          </h1>
          <p className="mt-3 text-sm text-zinc-600">Effective date: {EFFECTIVE_DATE}</p>
        </header>

        <article className="space-y-8 text-[15px] leading-7 text-zinc-700">
          <section>
            <h2 className="mb-3 text-lg font-semibold text-zinc-900">1. Who we are</h2>
            <p>
              This Privacy Policy describes how <strong>ALMA Lifestyle</strong> (&ldquo;we&rdquo;, &ldquo;us&rdquo;, or
              &ldquo;our&rdquo;) collects, uses, and protects personal information. ALMA Lifestyle is operated by{' '}
              <strong>Maruf Billah</strong>, based in <strong>Dhaka, Bangladesh</strong>.
            </p>
            <p className="mt-3">
              We use this policy for our customer-facing services, including communications through our Facebook
              Pages and related order support channels.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold text-zinc-900">2. Facebook Messenger</h2>
            <p>
              When you send a message to our Facebook Pages, we receive the content of your message through the
              Facebook Messenger platform. We use these messages solely to:
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-6">
              <li>Provide product information and pricing</li>
              <li>Answer customer enquiries</li>
              <li>Process and support orders placed through Messenger</li>
            </ul>
            <p className="mt-3">
              We only access messages that customers voluntarily send to our Pages. We do not initiate unsolicited
              marketing messages outside normal customer support and order-related communication.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold text-zinc-900">3. Information we collect</h2>
            <p>Depending on how you contact us, we may collect:</p>
            <ul className="mt-3 list-disc space-y-1 pl-6">
              <li>Your name (as provided in Messenger or during an order)</li>
              <li>Message content and conversation history</li>
              <li>Order details such as products, quantities, delivery address, and phone number</li>
              <li>Payment and delivery information needed to fulfil your order</li>
            </ul>
            <p className="mt-3">
              We collect only the information necessary to respond to your enquiry, complete your order, and provide
              after-sales support.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold text-zinc-900">4. How we use your information</h2>
            <p>We use the information described above <strong>only</strong> for:</p>
            <ul className="mt-3 list-disc space-y-1 pl-6">
              <li>Customer support and responding to your messages</li>
              <li>Order processing, fulfilment, and delivery coordination</li>
              <li>Following up on orders, returns, or support issues you have raised with us</li>
            </ul>
            <p className="mt-3">
              We do not use your personal data for unrelated purposes, and we do not sell, rent, or trade your
              personal information to third parties.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold text-zinc-900">5. Sharing with third parties</h2>
            <p>
              We do <strong>not</strong> sell customer data to third parties. We may share limited information only
              when required to operate our business, for example:
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-6">
              <li>Delivery partners, to ship your order to the address you provide</li>
              <li>Payment processors or banks, when needed to complete a transaction you initiate</li>
              <li>Legal or regulatory authorities, if required by applicable law</li>
            </ul>
            <p className="mt-3">
              Facebook/Meta processes Messenger communications according to its own privacy policy. Our use of
              Messenger data is limited to the purposes described in this policy.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold text-zinc-900">6. Data retention</h2>
            <p>
              We retain customer conversations and order-related records for as long as needed to provide support,
              fulfil orders, resolve disputes, and meet reasonable business and legal requirements.
            </p>
            <p className="mt-3">
              If you request deletion of your conversation or personal data, we will remove it within a reasonable
              timeframe unless we are required to retain certain records for legal, accounting, or dispute-resolution
              purposes.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold text-zinc-900">7. Data security</h2>
            <p>
              We take reasonable technical and organisational measures to protect customer information against
              unauthorised access, loss, or misuse. No method of transmission or storage is completely secure, but we
              work to safeguard the data we hold.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold text-zinc-900">8. Your rights and contact</h2>
            <p>
              You may contact us to ask questions about this policy, request access to your data, or request
              deletion of your conversation records where applicable.
            </p>
            <p className="mt-3">
              <strong>Contact:</strong>{' '}
              <a
                href="mailto:almatraders.com@gmail.com"
                className="font-medium text-zinc-900 underline decoration-zinc-400 underline-offset-2 hover:decoration-zinc-900"
              >
                almatraders.com@gmail.com
              </a>
            </p>
            <p className="mt-3">
              <strong>Business:</strong> ALMA Lifestyle<br />
              <strong>Owner:</strong> Maruf Billah<br />
              <strong>Location:</strong> Dhaka, Bangladesh
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold text-zinc-900">9. Changes to this policy</h2>
            <p>
              We may update this Privacy Policy from time to time. The effective date at the top of this page will
              reflect the latest version. Continued use of our Messenger channels after an update constitutes
              acceptance of the revised policy.
            </p>
          </section>
        </article>

        <footer className="mt-12 border-t border-zinc-200 pt-6 text-sm text-zinc-500">
          &copy; {new Date().getFullYear()} ALMA Lifestyle. All rights reserved.
        </footer>
      </div>
    </main>
  )
}
