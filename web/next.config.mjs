/** @type {import('next').NextConfig} */
const nextConfig = {
  // @libsql/client uses native bindings; keep it out of the server bundle
  // so it's required at runtime instead of bundled (needed for both local
  // `next dev`/`next start` and Vercel's serverless functions).
  serverExternalPackages: ["@libsql/client"],
};

export default nextConfig;
