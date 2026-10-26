import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: [
    "postgres",
    "pg-boss",
    "undici",
    "@anthropic-ai/sdk",
    "@opentelemetry/api",
    "@opentelemetry/sdk-trace",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/context-async-hooks",
  ],
};

export default config;
