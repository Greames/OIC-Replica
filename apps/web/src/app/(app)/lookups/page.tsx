import { ComingSoon } from "@/components/coming-soon";

export const metadata = { title: "Lookups" };

export default function Page() {
  return (
    <ComingSoon title="Lookups" phase={5}>
      Value maps between systems, editable as a grid or imported from CSV, usable in any mapping.
    </ComingSoon>
  );
}
