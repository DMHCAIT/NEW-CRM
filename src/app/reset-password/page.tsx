import Link from "next/link";

export default function ResetPasswordPage() {
  return <main className="auth-page"><section className="panel auth-card"><h1>Contact your Super Admin</h1><p>Password changes are managed directly by your Super Admin. Email password-reset links are no longer supported.</p><Link href="/login">Return to sign in</Link></section></main>;
}
