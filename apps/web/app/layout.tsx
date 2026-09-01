import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/components/auth/AuthProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'Toit Reconciliation',
  description: 'Payment reconciliation and MPR (Layer 2) settlement matching for Toit outlets.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
