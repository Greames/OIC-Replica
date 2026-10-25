import { ComingSoon } from "@/components/coming-soon";

export const metadata = { title: "Connections" };

export default function Page() {
  return (
    <ComingSoon title="Connections" phase={1}>
      Connect REST APIs with basic auth or API keys, test them, and store credentials encrypted.
    </ComingSoon>
  );
}
