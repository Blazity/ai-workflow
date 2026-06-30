import InviteAcceptForm from "./invite-accept-form";

export default async function InviteAcceptPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string | string[] }>;
}) {
  const params = await searchParams;
  const inviteId = Array.isArray(params.id) ? params.id[0] : params.id;
  return <InviteAcceptForm inviteId={inviteId ?? ""} />;
}
