import InviteAcceptForm from "./invite-accept-form";

export default async function InviteAcceptPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const params = await searchParams;
  return <InviteAcceptForm inviteId={params.id ?? ""} />;
}
