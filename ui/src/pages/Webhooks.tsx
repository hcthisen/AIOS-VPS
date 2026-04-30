import React, { useEffect, useState } from "react";
import { api, getActiveCompanySlug } from "../api";
import { Section } from "../components/Section";
import { IconButton } from "../components/IconButton";

interface WebhookHandler {
  department: string;
  name: string;
  endpoint: string;
  relPath: string;
  hasSecret: boolean;
  promptPreview: string;
  deliveries: number;
  lastOutcome: string | null;
  lastReceivedAt: number | null;
}

interface WebhookDelivery {
  id: number;
  department: string | null;
  endpoint: string;
  source: string | null;
  payload: string | null;
  outcome: string;
  received_at: number;
}

export function WebhooksPage({ navigate }: { navigate: (t: string) => void }) {
  const [handlers, setHandlers] = useState<WebhookHandler[]>([]);
  const [rows, setRows] = useState<WebhookDelivery[]>([]);
  const [selectedEndpoint, setSelectedEndpoint] = useState<string | null>(null);
  const [selectedDeliveryId, setSelectedDeliveryId] = useState<number | null>(null);

  useEffect(() => {
    api<{ handlers: WebhookHandler[] }>("/api/webhooks/handlers").then((r) => setHandlers(r.handlers));
  }, []);

  useEffect(() => {
    const load = () => api<{ deliveries: WebhookDelivery[] }>("/api/webhooks/deliveries").then((r) => setRows(r.deliveries));
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selectedEndpoint && handlers.length) setSelectedEndpoint(handlers[0].endpoint);
  }, [handlers, selectedEndpoint]);

  useEffect(() => {
    if (selectedDeliveryId && !rows.some((row) => row.id === selectedDeliveryId)) {
      setSelectedDeliveryId(rows[0]?.id || null);
    }
  }, [rows, selectedDeliveryId]);

  const selectedDelivery = rows.find((row) => row.id === selectedDeliveryId) || null;
  const activeEndpoint = selectedDelivery?.endpoint || selectedEndpoint;
  const selectedHandler = handlers.find((handler) => handler.endpoint === activeEndpoint) || null;
  const companySlug = getActiveCompanySlug();
  const endpointUrl = activeEndpoint ? `${window.location.origin}/webhooks/${companySlug ? `${companySlug}/` : ""}${activeEndpoint}` : null;
  const exampleMarkdown = buildWebhookExampleMarkdown(selectedHandler, endpointUrl || "");

  return (
    <div className="col">
      <div>
        <h2>Webhook deliveries</h2>
        <div className="small muted">
          Webhooks let external systems POST JSON into a department-specific markdown handler. The request is matched to
          <code> &lt;department&gt;/webhooks/&lt;name&gt;.md </code>
          and the payload is appended to that prompt before AIOS starts or queues a run.
        </div>
      </div>

      <div className="grid-2">
        <Section title="How it works" description="Each delivery follows the same path through the system.">
          <div className="small">1. AIOS receives a POST to <code>/webhooks/&lt;department&gt;/&lt;name&gt;</code>.</div>
          <div className="small">2. It looks for <code>&lt;department&gt;/webhooks/&lt;name&gt;.md</code> in the repo.</div>
          <div className="small">3. If that file defines a secret, AIOS checks it against <code>x-webhook-key</code>, <code>x-webhook-secret</code>, <code>?key=</code>, or <code>?secret=</code>.</div>
          <div className="small">4. AIOS appends the JSON payload under a <code>Payload</code> section and starts a run for that department. If the department is busy, the run is queued.</div>
        </Section>

        <Section
          title="Handler file"
          description={`Secrets are optional. Keep the logic in the markdown prompt, not in the dashboard.${selectedHandler ? ` The download includes a ready-to-edit handler file for ${selectedHandler.endpoint}.` : " The download uses placeholders you can fill in."}`}
          actions={
            <button className="primary" onClick={() => downloadExampleMarkdown(selectedHandler, exampleMarkdown)}>
              Download example .md
            </button>
          }
        >
          <pre className="code-block"><code>{exampleMarkdown}</code></pre>
        </Section>
      </div>

      <Section
        title="Configured handlers"
        actions={<span className="small muted">{handlers.length} endpoint{handlers.length === 1 ? "" : "s"}</span>}
        className="table-cards"
      >
        {!handlers.length ? (
          <div className="small muted">
            No webhook handlers yet. Add markdown files under <code>&lt;department&gt;/webhooks/</code> to create endpoints.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th>File</th>
                  <th>Secret</th>
                  <th>Deliveries</th>
                  <th>Last outcome</th>
                </tr>
              </thead>
              <tbody>
                {handlers.map((handler) => (
                  <tr
                    key={handler.endpoint}
                    onClick={() => {
                      setSelectedEndpoint(handler.endpoint);
                      setSelectedDeliveryId(null);
                    }}
                    style={{ cursor: "pointer", background: activeEndpoint === handler.endpoint ? "var(--panel-2)" : undefined }}
                  >
                    <td data-label="Endpoint">
                      <div><b>{handler.endpoint}</b></div>
                      <div className="small muted">{handler.promptPreview}</div>
                    </td>
                    <td className="mono small" data-label="File">{handler.relPath}</td>
                    <td data-label="Secret">{handler.hasSecret ? <span className="badge ok">required</span> : <span className="badge">optional</span>}</td>
                    <td data-label="Deliveries">{handler.deliveries}</td>
                    <td data-label="Last outcome">{handler.lastOutcome ? <span className={`badge ${outcomeClass(handler.lastOutcome)}`}>{outcomeLabel(handler.lastOutcome)}</span> : <span className="small muted">none yet</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <div className="grid-2">
        <Section title="Endpoint details">
          {!selectedHandler && <div className="small muted">Select a configured handler to inspect the live endpoint.</div>}
          {selectedHandler && (
            <>
              <div className="small"><b>Endpoint:</b> <code>{selectedHandler.endpoint}</code></div>
              <div className="small"><b>Path:</b> <code>{selectedHandler.relPath}</code></div>
              <div className="small"><b>Department:</b> {selectedHandler.department}</div>
              <div className="small"><b>Secret:</b> {selectedHandler.hasSecret ? "Required" : "Not required"}</div>
              <div className="small"><b>Latest result:</b> {selectedHandler.lastOutcome ? outcomeDetail(selectedHandler.lastOutcome) : "No deliveries yet."}</div>
              <div className="small"><b>POST URL:</b> <code>{endpointUrl}</code></div>
              <pre className="code-block"><code>{buildCurlExample(selectedHandler, endpointUrl || "")}</code></pre>
            </>
          )}
        </Section>

        <Section title="Selected delivery">
          {!selectedDelivery && <div className="small muted">Select a delivery row below to inspect the payload and linked run.</div>}
          {selectedDelivery && (
            <>
              <div className="small"><b>Received:</b> {new Date(selectedDelivery.received_at).toLocaleString()}</div>
              <div className="small"><b>Endpoint:</b> <code>{selectedDelivery.endpoint}</code></div>
              <div className="small"><b>Department:</b> {selectedDelivery.department || endpointDepartment(selectedDelivery.endpoint)}</div>
              <div className="small"><b>Source:</b> {selectedDelivery.source || "Not captured for this delivery."}</div>
              <div className="small"><b>Outcome:</b> <span className={`badge ${outcomeClass(selectedDelivery.outcome)}`}>{outcomeLabel(selectedDelivery.outcome)}</span> <span className="muted">{outcomeDetail(selectedDelivery.outcome)}</span></div>
              {runIdFromOutcome(selectedDelivery.outcome) && (
                <div className="small">
                  <a onClick={() => navigate(`/runs/${runIdFromOutcome(selectedDelivery.outcome)}`)}>Open linked run</a>
                </div>
              )}
              <div className="small muted">Stored payload snapshot</div>
              <pre className="payload-block">{formatPayload(selectedDelivery.payload)}</pre>
            </>
          )}
        </Section>
      </div>

      <Section
        title="Recent deliveries"
        actions={<span className="small muted">Newest first, auto-refresh every 5s</span>}
        className="table-cards"
      >
        {!rows.length ? (
          <div className="small muted">No deliveries yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Received</th>
                  <th>Endpoint</th>
                  <th>Source</th>
                  <th>Outcome</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((delivery) => {
                  const runId = runIdFromOutcome(delivery.outcome);
                  return (
                    <tr
                      key={delivery.id}
                      onClick={() => {
                        setSelectedDeliveryId(delivery.id);
                        setSelectedEndpoint(delivery.endpoint);
                      }}
                      style={{ cursor: "pointer", background: selectedDeliveryId === delivery.id ? "var(--panel-2)" : undefined }}
                    >
                      <td className="mono small" data-label="Received">{new Date(delivery.received_at).toLocaleString()}</td>
                      <td data-label="Endpoint">
                        <div><b>{delivery.endpoint}</b></div>
                        <div className="small muted">{delivery.department || endpointDepartment(delivery.endpoint)}</div>
                      </td>
                      <td className="small muted" data-label="Source">{delivery.source || "-"}</td>
                      <td data-label="Outcome"><span className={`badge ${outcomeClass(delivery.outcome)}`}>{outcomeLabel(delivery.outcome)}</span></td>
                      <td data-label="Actions" style={{ textAlign: "right" }}>
                        {runId ? (
                          <IconButton onClick={() => navigate(`/runs/${runId}`)}>View run</IconButton>
                        ) : (
                          <span className="small muted">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

function endpointDepartment(endpoint: string) {
  return endpoint.split("/")[0] || "unknown";
}

function runIdFromOutcome(outcome: string): string | null {
  return outcome.startsWith("run:") ? outcome.slice(4) : null;
}

function outcomeClass(outcome: string) {
  if (outcome.startsWith("run:")) return "ok";
  if (outcome === "queued") return "warn";
  if (outcome.startsWith("rejected:")) return "err";
  return "";
}

function outcomeLabel(outcome: string) {
  if (outcome.startsWith("run:")) return "run started";
  if (outcome === "queued") return "queued";
  if (outcome === "rejected:unknown-dept") return "unknown department";
  if (outcome === "rejected:no-handler") return "no handler";
  if (outcome === "rejected:bad-key") return "bad secret";
  return outcome;
}

function outcomeDetail(outcome: string) {
  const runId = runIdFromOutcome(outcome);
  if (runId) return `Accepted and started run ${runId}.`;
  if (outcome === "queued") return "The department was busy, so the request was accepted into backlog for retry.";
  if (outcome === "rejected:unknown-dept") return "The endpoint points to a department that is not listed in aios.yaml.";
  if (outcome === "rejected:no-handler") return "The department exists, but the webhook markdown handler file was not found.";
  if (outcome === "rejected:bad-key") return "The handler requires a secret and the supplied secret did not match.";
  return outcome;
}

function formatPayload(payload: string | null) {
  if (!payload) return "(no payload captured)";
  try { return JSON.stringify(JSON.parse(payload), null, 2); } catch { return payload; }
}

function buildCurlExample(handler: WebhookHandler, endpointUrl: string) {
  const authLine = handler.hasSecret ? '  -H "x-webhook-key: <your-secret>" \\\n' : "";
  return `curl -X POST "${endpointUrl}" \\
  -H "Content-Type: application/json" \\
${authLine}  -d '{"event":"test","source":"dashboard-example"}'`;
}

function buildWebhookExampleMarkdown(handler: WebhookHandler | null, endpointUrl: string) {
  const department = handler?.department || "<department>";
  const name = handler?.name || "<name>";
  const endpoint = handler?.endpoint || `${department}/${name}`;
  const filePath = handler?.relPath || `${department}/webhooks/${name}.md`;
  const url = endpointUrl || `${window.location.origin}/webhooks/${endpoint}`;
  const secretLine = 'webhookKey: "replace-with-a-random-secret-or-delete-this-line"';

  return `---
${secretLine}
provider: "codex"
---
# Webhook handler for ${endpoint}

Save this file at \`${filePath}\`.

## Endpoint
- Relative path: \`/webhooks/${endpoint}\`
- Full URL: \`${url}\`

## Secret
- If \`webhookKey\` is present, callers must send the same value in \`x-webhook-key\`
- AIOS also accepts \`x-webhook-secret\`, \`?key=\`, and \`?secret=\`
- Delete the \`webhookKey\` line if you want this endpoint to accept unsigned requests

## What AIOS does automatically
- It matches this file from the incoming URL
- It appends the incoming JSON under a \`Payload\` section below this prompt
- It starts a run for the \`${department}\` department, or queues it if that department is already busy

## Suggested behavior
1. Summarize the event in plain language
2. Identify whether follow-up work is required
3. Update repository files only when the payload justifies a durable change
4. If no action is needed, leave a short note in the run log and stop

## Example request with secret
\`\`\`bash
curl -X POST "${url}" \\
  -H "Content-Type: application/json" \\
  -H "x-webhook-key: replace-with-a-random-secret-or-delete-this-line" \\
  -d '{"event":"test","source":"dashboard-example","department":"${department}"}'
\`\`\`

## Example request without secret
\`\`\`bash
curl -X POST "${url}" \\
  -H "Content-Type: application/json" \\
  -d '{"event":"test","source":"dashboard-example","department":"${department}"}'
\`\`\`

## Task instructions for the agent
Review the incoming payload and decide what action this department should take.

Create a short summary, identify any follow-up work, and update the repo if needed.`;
}

function downloadExampleMarkdown(handler: WebhookHandler | null, markdown: string) {
  const filename = handler ? `${handler.name}.md` : "webhook-handler.md";
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}
