# Dharma Service Desk

Open source service desk for incidents, problems, changes, requests, knowledge, and configuration items. Organizations can turn modules on or off and edit groups, catalog items, states, SLAs, assignment rules, and the HIPAA policy.

This is an independent project. It is not ServiceNow, and it is not affiliated with ServiceNow.

## What you can run today

- Incident, problem, change, and request queues
- Service catalog that opens a routed request
- Knowledge base, with PHI articles encrypted
- Configuration management records
- SLA clocks that follow business hours
- Role-based access, groups, and in-app alerts
- Change approval before scheduling or implementation
- Dashboards and simple reports
- Organization configuration, including export and restore of that configuration

## PHI and HIPAA technical safeguards

The desk includes controls that map to common HIPAA Security Rule safeguards:

- Unique accounts and role permissions
- Purpose required before PHI is opened, with the open written to the audit trail
- AES-256-GCM encryption for PHI fields at rest
- Break-the-glass emergency access for 15 minutes, with a reason and an alert to privacy staff
- Idle session lock
- Hash-chained audit trail and a record integrity hash
- Retention check before PHI disposal
- A guard that rejects identifiers typed into titles, public notes, and descriptions

Using this software does not by itself make an organization HIPAA compliant. Compliance also takes policies, a risk analysis, business associate agreements, training, and the rest of your own program. The policy text shipped with the sample organization is a starting point, not legal advice.

Set `PHI_MASTER_KEY` before production use and back it up separately from the database. If the key is lost, encrypted PHI cannot be read.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:3000.

The first launch creates `data/db.json` and `data/phi.key` for the sample organization Northwind Community Health. Delete `data/db.json` to load that sample again. Do not delete `phi.key` if you still need to read existing PHI.

Sample password for every demo account: `Northwind-2026`

| Person | Email | Role |
| --- | --- | --- |
| Avery Chen | avery.chen@northwind.example | Administrator |
| Jordan Blake | jordan.blake@northwind.example | Privacy officer |
| Samir Patel | samir.patel@northwind.example | Service desk |
| Riley Nguyen | riley.nguyen@northwind.example | Change manager |
| Quinn Alvarez | quinn.alvarez@northwind.example | Requester |
| Morgan Ellis | morgan.ellis@northwind.example | Knowledge author |

Turn off the demo banner in Configure, and change these passwords, before anyone else can reach the server.

## Production

```bash
npm run build
npm start
```

```text
PHI_MASTER_KEY=  # 32 bytes as 64 hex characters or standard base64
```

Put the app behind HTTPS. Keep `data/` on a private volume.

## License

MIT. See [LICENSE](LICENSE).
