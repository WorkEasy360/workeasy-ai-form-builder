import { AuthFrame } from "../../auth-frame";
import { AcceptInvitation } from "./accept-invitation";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <AuthFrame>
      <AcceptInvitation token={token} />
    </AuthFrame>
  );
}
