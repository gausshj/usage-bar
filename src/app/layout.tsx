import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Usage Dashboard — LLM API Usage Monitor',
  description:
    'Monitor and track LLM API usage across providers with quota and sync health.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
