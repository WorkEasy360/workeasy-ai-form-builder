import { CreateForm } from "./create-form";

export default async function NewFormPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return <CreateForm orgId={orgId} />;
}
