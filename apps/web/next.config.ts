import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["postgres", "pg-boss", "undici", "@anthropic-ai/sdk"],
};

export default config;
