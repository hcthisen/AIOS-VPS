export function outboxInstructionsBody(): string {
  return `## Owner notifications

Use the \`outbox-notifications\` skill when you need to notify the owner.

Agents must not call Telegram or email directly. To notify the owner, write a concise markdown file to \`outbox/*.md\`; AIOS will store it, remove the file from \`outbox/\`, show it on the dashboard, and deliver it through Telegram or email when configured.

Only create an outbox notification when:
- The user, task, cron job, or goal explicitly asks for a notification, report, briefing, or summary.
- An emergency or important incident happens, including outages, security risk, billing risk, data-loss risk, failed automation needing owner action, or a problem you fixed that the owner should know about.

Do not create notifications for routine successful work, ordinary progress updates, or healthy monitoring checks unless the prompt explicitly asks for that report.

Outbox file format:
\`\`\`md
---
title: "Website outage fixed"
priority: warning
tags: [monitoring, website]
---

example.com was offline at 07:12, I restarted the service, and it is responding normally now.
\`\`\`

Use \`priority: info\`, \`warning\`, or \`critical\`. Keep the message owner-facing, short, factual, and free of secrets.`;
}
