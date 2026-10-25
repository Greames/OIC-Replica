import { PageHeader } from "@/components/ui/card";
import { requireViewer } from "@/lib/session";
import { LookupEditor } from "../lookup-editor";

export const metadata = { title: "New lookup" };

export default async function NewLookupPage() {
  await requireViewer();
  return (
    <>
      <PageHeader title="New lookup" description="One column per system, one row per value." />
      <LookupEditor id={null} initial={{ name: "", description: "", domains: ["", ""], rows: [["", ""]] }} usage={[]} />
    </>
  );
}
