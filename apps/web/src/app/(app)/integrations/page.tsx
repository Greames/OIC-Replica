import { ComingSoon } from "@/components/coming-soon";

export const metadata = { title: "Integrations" };

export default function Page() {
  return (
    <ComingSoon title="Integrations" phase={1}>
      Create scheduled and request-triggered integrations, run them, and see every step. The AI builder follows in phase
      2 and the visual canvas in phase 3.
    </ComingSoon>
  );
}
