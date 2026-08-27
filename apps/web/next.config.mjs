/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Workspace packages ship as ESM with NodeNext-style specifiers; letting Next
  // transpile them keeps the app working whether or not `dist/` has been built
  // by a prior `tsc -b`.
  transpilePackages: ['@toit/recon-core', '@toit/contracts'],

  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
