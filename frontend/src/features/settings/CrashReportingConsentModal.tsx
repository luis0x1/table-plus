import { Alert } from '../../components/ui/icons'

export default function CrashReportingConsentModal(props: { onAccept: () => void; onDecline: () => void }) {
  return (
    <div class="modal-backdrop crash-consent-backdrop">
      <section class="crash-consent-modal" role="dialog" aria-modal="true" aria-labelledby="crash-consent-title">
        <div class="crash-consent-icon">
          <Alert size={21} />
        </div>
        <h3 id="crash-consent-title">Help improve QueryNest?</h3>
        <p>
          QueryNest can send crash reports to GlitchTip when something goes wrong. Reports contain the error message and
          stack trace. QueryNest does not intentionally attach database contents, connection passwords, user identity,
          breadcrumbs, or session recordings.
        </p>
        <p class="crash-consent-note">This is off by default. You can change it later in Settings.</p>
        <footer>
          <button class="secondary" onClick={props.onDecline}>
            No thanks
          </button>
          <button class="primary" onClick={props.onAccept}>
            Send crash reports
          </button>
        </footer>
      </section>
    </div>
  )
}
