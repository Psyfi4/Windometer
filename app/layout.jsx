import './globals.css';

export const metadata = {
  title: 'Windlab — wind forecasting workbench',
  description:
    'Run machine-learning and hybrid wind-speed forecasting models on your own data. '
    + 'Everything computes in the browser: nothing is uploaded to a server.',
};

export const viewport = { themeColor: '#0a0f14' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
