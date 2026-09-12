/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable standalone output for Docker deployment
  output: 'standalone',

  // Trace from this directory, not an inferred one. Without this, a lockfile in
  // any parent folder silently becomes the root and the standalone bundle is
  // traced from the wrong place.
  outputFileTracingRoot: __dirname,

  // Optimize for production
  reactStrictMode: true,
  
  // Enable image optimization
  images: {
    unoptimized: true,
  },
  
  // Environment variables available at build time
  // AGENT_FRAMEWORK_URL is for server-side API routes (proxying to backend)
  // NEXT_PUBLIC_AGENT_FRAMEWORK_URL is for client-side (should use /api/agent-framework proxy)
  env: {
    AGENT_FRAMEWORK_URL: process.env.AGENT_FRAMEWORK_URL || 'http://localhost:8000',
    // Client uses the API proxy route by default (works in all environments)
    NEXT_PUBLIC_AGENT_FRAMEWORK_URL: process.env.NEXT_PUBLIC_AGENT_FRAMEWORK_URL || '/api/agent-framework',
  },
  
  // Disable x-powered-by header for security
  poweredByHeader: false,
};

module.exports = nextConfig;
