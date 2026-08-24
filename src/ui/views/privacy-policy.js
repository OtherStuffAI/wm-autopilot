/**
 * Privacy policy page renderer — static HTML content with back-to-home link.
 *
 * Depends on: HOME_ROUTE, setCurrentRoute, render (via DI).
 */

export function initPrivacyPolicy(deps) {
  const { HOME_ROUTE, setCurrentRoute, render } = deps;

  const renderPrivacyPolicy = () => {
    const wrapper = document.createElement("div");
    wrapper.className = "wm-privacy-policy";

    const header = document.createElement("header");
    header.className = "wm-privacy-policy__header";
    const title = document.createElement("h1");
    title.textContent = "Privacy Policy";
    const lastUpdated = document.createElement("p");
    lastUpdated.className = "wm-privacy-policy__date";
    lastUpdated.textContent = "Last updated: February 2025";
    header.append(title, lastUpdated);

    const content = document.createElement("article");
    content.className = "wm-privacy-policy__content";
    content.innerHTML = `
    <section>
      <h2>Introduction</h2>
      <p>Welcome to Wingman. We are committed to protecting your privacy and ensuring you have a positive experience when using our AI agent orchestration platform. This policy outlines our data handling practices.</p>
    </section>

    <section>
      <h2>Information We Collect</h2>
      <h3>Identity Information</h3>
      <p>Wingman uses Nostr-based identity for authentication. When you sign in, we may collect:</p>
      <ul>
        <li>Your public key (npub) for identification</li>
        <li>Session tokens for maintaining your logged-in state</li>
        <li>Profile metadata you choose to share</li>
      </ul>

      <h3>Usage Data</h3>
      <p>We collect information about how you interact with Wingman, including:</p>
      <ul>
        <li>Agent sessions you create and manage</li>
        <li>Projects and todos you create within the platform</li>
        <li>Configuration preferences and settings</li>
        <li>Log data from agent interactions</li>
      </ul>

      <h3>Technical Data</h3>
      <p>When you use Wingman, we may automatically collect:</p>
      <ul>
        <li>Browser type and version</li>
        <li>Device information</li>
        <li>IP address (for security and rate limiting)</li>
        <li>Access timestamps</li>
      </ul>
    </section>

    <section>
      <h2>How We Use Your Information</h2>
      <p>We use the collected information to:</p>
      <ul>
        <li>Provide and maintain the Wingman service</li>
        <li>Authenticate your identity and manage access</li>
        <li>Store your projects, todos, and preferences</li>
        <li>Improve our platform and develop new features</li>
        <li>Ensure security and prevent abuse</li>
        <li>Communicate important updates about the service</li>
      </ul>
    </section>

    <section>
      <h2>Data Storage and Security</h2>
      <p>Your data is stored locally on the Wingman server instance you connect to. We implement security measures including:</p>
      <ul>
        <li>Encrypted storage for sensitive data (todos, credentials)</li>
        <li>Session-based authentication with secure cookies</li>
        <li>Role-based access control for administrative functions</li>
      </ul>
      <p>Agent conversation data and logs are stored for the duration of your session and may be persisted based on your configuration.</p>
    </section>

    <section>
      <h2>Data Sharing</h2>
      <p>We do not sell your personal information. We may share data only:</p>
      <ul>
        <li>With your explicit consent</li>
        <li>To comply with legal obligations</li>
        <li>To protect our rights and prevent misuse</li>
        <li>With service providers who assist in operating the platform (under strict confidentiality agreements)</li>
      </ul>
    </section>

    <section>
      <h2>Your Rights</h2>
      <p>You have the right to:</p>
      <ul>
        <li>Access the personal data we hold about you</li>
        <li>Request correction of inaccurate data</li>
        <li>Request deletion of your data</li>
        <li>Export your data in a portable format</li>
        <li>Withdraw consent for data processing</li>
      </ul>
    </section>

    <section>
      <h2>Cookies and Local Storage</h2>
      <p>Wingman uses browser storage technologies to:</p>
      <ul>
        <li>Maintain your authentication state</li>
        <li>Store UI preferences (theme, layout settings)</li>
        <li>Cache data for improved performance</li>
      </ul>
      <p>These are essential for the platform to function and cannot be disabled while using the service.</p>
    </section>

    <section>
      <h2>Third-Party Services</h2>
      <p>Wingman integrates with external AI agent services (Claude, Codex, Goose, OpenCode). When you use these agents:</p>
      <ul>
        <li>Your prompts and data may be processed by the respective AI providers</li>
        <li>Each provider has their own privacy policies which govern their handling of your data</li>
        <li>We recommend reviewing the privacy policies of any AI services you choose to use</li>
      </ul>
    </section>

    <section>
      <h2>Changes to This Policy</h2>
      <p>We may update this privacy policy from time to time. We will notify you of significant changes by posting a notice on the platform or through other appropriate means.</p>
    </section>

    <section>
      <h2>Contact Us</h2>
      <p>If you have questions about this privacy policy or our data practices, please reach out through our official channels.</p>
    </section>
  `;

    const footer = document.createElement("footer");
    footer.className = "wm-privacy-policy__footer";
    const backLink = document.createElement("a");
    backLink.href = HOME_ROUTE;
    backLink.className = "wm-button secondary";
    backLink.textContent = "Back to Home";
    backLink.addEventListener("click", (e) => {
      e.preventDefault();
      setCurrentRoute("home");
      window.history.pushState({ route: "home" }, "", HOME_ROUTE);
      render();
    });
    footer.append(backLink);

    wrapper.append(header, content, footer);
    return wrapper;
  };

  return { renderPrivacyPolicy };
}
