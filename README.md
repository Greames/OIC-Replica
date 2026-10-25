# OIC-Replica

An AI-first integration platform. It does the core of what Oracle Integration
does (connections, flows, mapping, scheduling, monitoring, resubmit), but you
build integrations by describing them in plain English instead of drawing
every step by hand.

> Working name. It gets its own name and brand before launch. It is an
> independent product and is not affiliated with Oracle.

- **AI builder:** say what you want ("every 15 minutes, send new orders from
  Postgres to our shop API and email me on failure"). Claude asks what it
  needs, builds the flow, and you review the changes before they apply.
- **Visual canvas and mapper:** see and fine-tune what the AI built.
- **Every update, everywhere:** live in the app, in Slack, Telegram or email,
  or through [Hermes Agent](https://github.com/NousResearch/hermes-agent) and
  any other MCP client via the built-in MCP server.
- **Self-hostable:** `docker compose up`.

## Plan

| file | what |
| --- | --- |
| [replica/recon.md](replica/recon.md) | what the original does: screens, flows, data model, what's out of scope |
| [replica/features.csv](replica/features.csv) | feature matrix (must / should / could) |
| [replica/architecture.md](replica/architecture.md) | stack, AI builder, Hermes/MCP design, API, build phases |
| [replica/schema.sql](replica/schema.sql) | the database schema |

Built one phase at a time. Phase 0 (foundation) is next.
