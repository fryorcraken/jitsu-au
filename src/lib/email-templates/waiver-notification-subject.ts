/**
 * The subject line of the managers' "new waiver" email, which its preview text
 * repeats. One place, so the inbox list and the opened email cannot describe the
 * waiver differently. Its own module because a component file may only export
 * components (fast refresh).
 */
export function waiverNotificationSubject(p: {
  memberName: string;
  memberEmail: string;
  signedByName?: string | null;
}): string {
  return p.signedByName
    ? `New waiver signed by ${p.signedByName} for ${p.memberName}`
    : `New waiver signed by ${p.memberName || p.memberEmail}`;
}
