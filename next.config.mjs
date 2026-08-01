/** @type {import('next').NextConfig} */
const nextConfig = {
  // Fully static output: Vercel serves files from the CDN and never runs a
  // server function. All computation happens in the visitor's browser.
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
};

export default nextConfig;
