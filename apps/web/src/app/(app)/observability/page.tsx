import { ComingSoon } from "@/components/coming-soon";

export const metadata = { title: "Observability" };

export default function Page() {
  return (
    <ComingSoon title="Observability" phase={1}>
      Every run with its steps and payloads. Errors, resubmit and dashboards follow in phase 6, and live updates to
      Slack, Telegram and Hermes Agent in phase 4.
    </ComingSoon>
  );
}
