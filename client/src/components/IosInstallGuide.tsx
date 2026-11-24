/** Shown when running in iOS Safari (not as a Home Screen app), where Web Push is unavailable. */
export function IosInstallGuide() {
  return (
    <section className="card callout" aria-labelledby="ios-install-title">
      <h2 id="ios-install-title">Install BandAlert on your iPhone</h2>
      <p className="muted small">
        Push alerts on iOS need iOS 16.4 or later and an app installed to your Home Screen.
      </p>
      <ol className="steps">
        <li>
          Open this page in <strong>Safari</strong> over HTTPS.
        </li>
        <li>
          Tap the <strong>Share</strong> button <span aria-hidden="true">⎋</span>.
        </li>
        <li>
          Choose <strong>Add to Home Screen</strong>.
        </li>
        <li>
          Launch <strong>BandAlert</strong> from the Home Screen icon, then enable notifications below.
        </li>
      </ol>
    </section>
  );
}
