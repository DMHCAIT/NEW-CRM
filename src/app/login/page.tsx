"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, Fingerprint, LoaderCircle, LockKeyhole, Mail, ShieldCheck } from "lucide-react";
import { safeNextPath } from "@/lib/auth-routing";
import { apiRequest, errorMessage } from "@/lib/crm-data";
import styles from "./login.module.css";

export default function LoginPage() {
  const [step, setStep] = useState<"password" | "code">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("passwordUpdated") === "1") setNotice("Your password has been updated. Sign in with your new password.");
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (step === "password") {
        await apiRequest("/api/auth/login", { body: { email, password } });
        setPassword("");
        setShowPassword(false);
        setNotice("");
        setStep("code");
      } else {
        await apiRequest("/api/auth/verify", { body: { code } });
        window.location.assign(safeNextPath(new URLSearchParams(window.location.search).get("next")));
      }
    } catch (error) { setError(errorMessage(error, "Sign-in failed. Please try again.")); }
    finally { setBusy(false); }
  }
  return <main className={styles.page}>
    <aside className={styles.story} aria-label="DMHCA admissions workspace">
      <div className={styles.brand}><span>DMHCA<span className={styles.brandCaption}>ADMISSIONS CRM</span></span></div>
      <div className={styles.storyBody}>
        <span className={styles.eyebrow}><span /> YOUR TEAM. ONE WORKSPACE.</span>
        <h2>Every connection.<br />{" "}A new <span>possibility.</span></h2>
        <p>A thoughtful workspace for your admissions team.<br className={styles.desktopBreak} /> Bring your leads, conversations and next steps together.</p>
        <div className={styles.visual} aria-hidden="true">
          <div className={styles.orbit} /><div className={styles.orbitInner} />
          <div className={styles.connectionLine} />
          <div className={`${styles.visualCard} ${styles.leadCard}`}><span className={styles.cardDot} /><div><strong>Meaningful connections</strong><span>Start with a conversation</span></div><ArrowRight size={15} /></div>
          <div className={`${styles.visualCard} ${styles.nextCard}`}><span className={styles.cardCheck}><Check size={15} /></span><div><strong>A clear next step</strong><span>Keep every opportunity moving</span></div></div>
          <span className={styles.orbitDot} /><span className={styles.smallDot} />
        </div>
      </div>
      <div className={styles.storyFooter}><ShieldCheck size={17} /><span>Built around your team. Protected at every step.</span></div>
    </aside>

    <section className={styles.loginSide} aria-labelledby="login-heading">
      <div className={styles.topNote}><LockKeyhole size={13} /> PRIVATE WORKSPACE</div>
      <div className={styles.formWrap}>
        <ol className={styles.steps} aria-label="Sign-in progress">
          <li className={step === "password" ? styles.currentStep : styles.completeStep} aria-current={step === "password" ? "step" : undefined}><span>{step === "code" ? <Check size={12} /> : "01"}</span> Account</li>
          <li className={styles.stepLine} aria-hidden="true" />
          <li className={step === "code" ? styles.currentStep : ""} aria-current={step === "code" ? "step" : undefined}><span>02</span> Verification</li>
        </ol>
        <div className={styles.formIcon}>{step === "password" ? <Fingerprint size={27} strokeWidth={1.5} /> : <Mail size={26} strokeWidth={1.5} />}</div>
        <h1 id="login-heading">{step === "password" ? "Welcome back." : "Check your inbox."}</h1>
        <p className={styles.intro}>{step === "password" ? "Sign in to your DMHCA workspace. Your next opportunity starts here." : <>We sent a verification code to <strong>{email}</strong>. Enter it below to securely sign in.</>}</p>
        {notice && <p className={styles.notice} role="status"><Check size={16} />{notice}</p>}
        <form onSubmit={submit} className={styles.form} aria-busy={busy}>
          <fieldset disabled={busy} className={styles.fields} aria-label={step === "password" ? "Account credentials" : "Email verification"}>
            {step === "password" ? <>
              <div className={styles.field}>
                <label htmlFor="login-email">Email address</label>
                <div className={styles.inputWrap}><Mail size={18} aria-hidden="true" /><input id="login-email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="you@company.com" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} /></div>
              </div>
              <div className={styles.field}>
                <label htmlFor="login-password">Password</label>
                <div className={styles.inputWrap}><LockKeyhole size={18} aria-hidden="true" /><input id="login-password" type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="Enter your password" value={password} onChange={(event) => setPassword(event.target.value)} required maxLength={1024} />
                  <button className={styles.reveal} type="button" aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} aria-controls="login-password" onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button>
                </div>
              </div>
            </> : <div className={styles.field}>
              <label htmlFor="login-code">Verification code</label>
              <input className={styles.codeInput} id="login-code" autoFocus type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} placeholder="000000" aria-describedby="code-hint" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} required />
              <span id="code-hint" className={styles.fieldHint}>Six-digit code &middot; Valid for 10 minutes</span>
            </div>}
          </fieldset>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <button className={styles.submit} disabled={busy} type="submit">
            {busy ? <><LoaderCircle size={18} className={styles.spinner} aria-hidden="true" />{step === "password" ? "Sending verification code..." : "Verifying..."}</> : <>{step === "password" ? "Continue" : "Verify and sign in"}<ArrowRight size={18} aria-hidden="true" /></>}
          </button>
          {step === "code" && <button className={styles.back} disabled={busy} type="button" onClick={() => { setStep("password"); setCode(""); setError(""); setShowPassword(false); }}><ArrowLeft size={15} /> Back to sign in / request a new code</button>}
        </form>
        <div className={styles.securityNote}><ShieldCheck size={18} /><p>{step === "password" ? "An email verification code adds an extra layer of protection after your password." : "Never share your verification code. Only enter a code you requested."}</p></div>
        <div className={styles.help}><span>{step === "password" ? "Having trouble signing in?" : "Didn't receive your code?"}</span><p>{step === "password" ? "Contact your CRM administrator for account access or a password reset." : "Check your spam folder, or go back to sign in to request a new code."}</p></div>
      </div>
      <footer className={styles.footer}><span>DMHCA Admissions CRM</span><span><span /> Secure access</span></footer>
    </section>
  </main>;
}
