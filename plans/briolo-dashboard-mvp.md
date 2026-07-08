# Briolo Dashboard — MVP Blueprint

**Objective:** Build the Briolo web dashboard that onboards non-technical entrepreneurs via an AI interview, generates an integration checklist, and coordinates the Screen Guide Chrome extension to execute each connection task.

**Domain:** `briolo.io` (registered 2026-05-28, Vercel)
**Demo tenant:** Lux & Glo (`luxandglo.com`) — Tenant #0
**Target:** Phase 1 = 3 paying tenants, ≥1 outside beauty
**Code home:** `E:\lux-and-glo\briolo-app\`
**No existing codebase** — greenfield build

---

## Architecture Decisions

| Concern | Decision | Why |
|---|---|---|
| Framework | Next.js 15 (App Router) | Vercel-native, RSC for fast AI streaming |
| Hosting | Vercel (briolo.io project) | Proxy already lives there |
| Auth | Supabase Auth (magic link + Google OAuth) | No password friction for non-tech users |
| Database | Supabase Postgres | Profiles, checklists, task state |
| AI | Claude Opus 4.8 via existing Vercel proxy pattern | Reuses established auth model |
| Extension bridge | Chrome `externally_connectable` + Supabase Realtime | Dashboard pushes task; extension listens |
| Styling | Tailwind + shadcn/ui | Fast, accessible, dark-mode by default |

---

## MVP Scope (Steps 1–7)

These seven steps deliver sign-up → AI interview → Screen Guide connection → working dashboard.
Content pipeline, approval flows, and billing are Phase 2.

---

## Step 1 — Project Scaffold

**Context:** Greenfield Next.js app. Deploys to Vercel at `briolo.io`. Supabase project for DB + auth.

**Tasks:**
1. `npx create-next-app@latest briolo-app --typescript --tailwind --app --src-dir` inside `E:\lux-and-glo\`
2. Install deps: `@supabase/supabase-js @supabase/ssr @anthropic-ai/sdk`
3. `npx shadcn@latest init` — dark theme, CSS variables
4. Create Supabase project `briolo-prod` — save `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
5. Add vars to `.env.local` and Vercel env (production + preview)
6. Push to GitHub `briolo-io/briolo-app`; connect Vercel; set domain `briolo.io`
7. Verify: `https://briolo.io` returns Next.js 200

**Exit criteria:**
- `npm run build` passes clean
- `briolo.io` resolves and returns the app
- Supabase dashboard shows the connected project

---

## Step 2 — Auth + Business Profile Schema

**Context:** Users are non-technical entrepreneurs. No passwords — magic link or Google OAuth only.
Every user is a "tenant" owning one business.

**Tasks:**

1. Enable Supabase Auth: Email (magic link) + Google OAuth
2. Create DB schema:

```sql
-- One tenant per business
create table tenants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users not null,
  business_name text,
  industry text,
  created_at timestamptz default now()
);

-- Brand profile (output of AI interview)
create table brand_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants not null unique,
  goals text,
  audience text,
  tone text,
  platforms text[],
  content_types text[],
  strategy_brief text,
  updated_at timestamptz default now()
);

-- Integration checklist (one row per platform to connect)
create table integrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants not null,
  platform text not null,
  display_name text not null,
  status text default 'pending',  -- pending | in_progress | complete | error | skipped
  task_goal text,                 -- the goalText sent to Screen Guide
  completed_at timestamptz,
  sort_order int default 0
);
```

3. Add RLS: tenants can only read/write their own rows
4. Build `/app/(auth)/login/page.tsx` — email + "Send magic link" + Google button
5. Build `middleware.ts` — redirect unauthenticated users to `/login`
6. Auto-create tenant row on first sign-in

**Exit criteria:**
- Magic link and Google OAuth both work
- Unauthenticated users redirect to `/login`
- New sign-in creates tenant row in DB

---

## Step 3 — AI Interview (Conversational Onboarding)

**Context:** After first sign-in, users land here. Chat-style AI conversation that extracts everything
Briolo needs. Output: brand profile + integration checklist stored to DB.

**Tasks:**

1. Create `/app/onboarding/page.tsx` — full-screen chat UI
   - AI messages left, user messages right
   - Text input + send at bottom
   - Dark background, Briolo orange AI avatar
   - Streaming responses (no waiting for full reply)

2. Create `/app/api/interview/route.ts` — Claude streaming endpoint:

```typescript
// POST /app/api/interview
// Body: { messages: [{role, content}][], tenantId: string }
// Returns: SSE stream of Claude response chunks

const SYSTEM = `You are Briolo's onboarding AI. Learn everything needed to run
this entrepreneur's content machine. Ask (conversationally, one question at a time):
1. Their business — what they sell, industry, stage
2. Their brand — tone, values, who they're talking to
3. Where they are today — current platforms and accounts
4. What success looks like — leads, sales, awareness, revenue
5. What content they want — video, posts, blogs, ads
6. How often they want to post

When you have enough, output a JSON block in <profile>...</profile> tags:
{
  "goals": "...",
  "audience": "...",
  "tone": "...",
  "platforms": ["meta", "shopify"],
  "contentTypes": ["short-form video", "instagram posts"],
  "strategyBrief": "2-3 sentence summary",
  "integrations": [
    {
      "platform": "meta_pixel",
      "displayName": "Meta Pixel",
      "taskGoal": "Connect the Meta Pixel to your website so Briolo can track ad performance",
      "sortOrder": 1
    }
  ]
}

Be warm, brief, one question at a time. Non-tech users get overwhelmed by walls of text.`;
```

3. Parse `<profile>` block from final AI message — save to `brand_profiles` + `integrations` tables
4. Redirect to `/setup` on completion
5. Skip `/onboarding` if `brand_profiles` row already exists (returning users go to `/dashboard`)

**Exit criteria:**
- Conversation streams smoothly end-to-end
- Final AI message contains parseable `<profile>` JSON
- `brand_profiles` and `integrations` rows created in DB
- User auto-redirected to `/setup`

---

## Step 4 — Extension Bridge

**Context:** Dashboard needs to push tasks to Screen Guide and receive completion signals.
Uses Chrome's `externally_connectable` API — no server relay needed for the task push.

**Sub-task A — Extension changes** (in `screen-guide-browser-v1`):

1. Add to `src/manifest.json`:
```json
"externally_connectable": {
  "matches": [
    "https://briolo.io/*",
    "https://*.briolo.io/*",
    "http://localhost:3000/*"
  ]
}
```

2. Add to `src/background.js` — external message handler:
```js
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  const allowed = ['https://briolo.io', 'http://localhost:3000'];
  if (!allowed.some(o => sender.url?.startsWith(o))) return;

  if (msg.type === 'BRIOLO_START_TASK') {
    state = { goalId: msg.integrationId, enabled: true, completed: false,
               thinking: false, confidence: 0, lastGuidance: null, history: [] };
    goal = { name: msg.displayName, description: msg.taskGoal };
    activeTabThen(async id => {
      chrome.sidePanel.open({ tabId: id }).catch(() => {});
      lastSig[id] = '';
      evaluate(id, { force: true });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'BRIOLO_GET_STATUS') {
    sendResponse({ installed: true, enabled: state.enabled, completed: state.completed });
    return true;
  }
});
```

3. When `result.status === 'complete'` in `evaluate()`, call back to Briolo API:
```js
// After state.completed = true, notify Briolo backend
if (state.goalId) {
  fetch('https://briolo.io/api/tasks/' + state.goalId + '/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ completedAt: new Date().toISOString() })
  }).catch(() => {});
}
```

4. Rebuild extension → bump manifest version to `0.6.0`

**Sub-task B — Dashboard extension utility** (`src/lib/extension-bridge.ts`):
```typescript
const EXT_ID = process.env.NEXT_PUBLIC_SCREEN_GUIDE_EXT_ID!;

export async function isExtensionInstalled(): Promise<boolean> {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(EXT_ID, { type: 'BRIOLO_GET_STATUS' },
        res => resolve(!!res?.installed));
    } catch { resolve(false); }
  });
}

export async function pushTask(task: {
  id: string; displayName: string; taskGoal: string;
}): Promise<boolean> {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(EXT_ID, {
        type: 'BRIOLO_START_TASK',
        integrationId: task.id,
        displayName: task.displayName,
        taskGoal: task.taskGoal,
      }, res => resolve(!!res?.ok));
    } catch { resolve(false); }
  });
}
```

**Sub-task C — Completion API route** (`/app/api/tasks/[id]/complete/route.ts`):
- Validates request (check integrationId belongs to a real tenant)
- Sets `integrations.status = 'complete'`, `completed_at = now()`
- Returns `{ ok: true }`

**Exit criteria:**
- `chrome.runtime.sendMessage(EXT_ID, { type: 'BRIOLO_START_TASK', ... })` from `briolo.io` opens side panel and starts guidance
- Completing a guided task POSTs to `/api/tasks/[id]/complete` and flips DB status
- Extension builds clean at v0.6.0

---

## Step 5 — Setup Page (Integration Checklist UI)

**Context:** Post-interview landing page. Shows the AI-generated checklist. One task runs at a time
via Screen Guide. Auto-advances when each task completes.

**Tasks:**

1. Create `/app/setup/page.tsx`:
   - Header: "Let's connect your tools — we'll guide you through each one"
   - Progress bar: `X of N connected`
   - Checklist: platform icon + name + status pill per row
   - Active task: pulsing orange indicator + "Screen Guide is running"
   - "Skip for now" per row → sets status `skipped`

2. Extension check on mount:
   - Call `isExtensionInstalled()`
   - Not installed → banner: "Install the Screen Guide extension" + Chrome Web Store link
   - Installed → "Screen Guide ready" green badge

3. Task orchestration (client-side):
```typescript
// Auto-advance through pending tasks
const nextTask = integrations.find(i => i.status === 'pending');
if (nextTask && extensionInstalled) {
  await supabase.from('integrations').update({ status: 'in_progress' }).eq('id', nextTask.id);
  await pushTask(nextTask);
}
```

4. Subscribe to Supabase Realtime on `integrations` table (this tenant):
   - On `status → complete`: find next pending task, push it automatically
   - All complete: show "All connected!" celebration → "Go to dashboard" button

**Exit criteria:**
- Checklist loads from Supabase
- First pending task auto-pushes to Screen Guide on page load (if extension installed)
- Completing a task auto-advances to the next
- "All done" routes to `/dashboard`

---

## Step 6 — Dashboard Shell + Core Tabs

**Context:** Main product home after setup. Four tabs. MVP: Overview + Integrations are real.
Content + Brand are functional stubs.

**Tasks:**

1. `/app/dashboard/layout.tsx`:
   - Left sidebar nav: Overview, Content, Integrations, Brand + Settings
   - Top bar: tenant business name + user avatar + sign out
   - Responsive: bottom nav on mobile

2. `/app/dashboard/page.tsx` (Overview):
   - Integration health banner: "8/8 connected ✓" or "1 needs attention ⚠"
   - "Briolo is working for you" hero card (content pipeline — Phase 2 populates this)
   - Quick stats row: placeholders for reach, posts live, this week
   - CTA card if any integrations are not complete: "Finish connecting →"

3. `/app/dashboard/integrations/page.tsx`:
   - Table: platform icon | name | status | last updated | action
   - "Re-connect" button → calls `pushTask()` for that integration
   - Error row: red badge + "Fix this" CTA
   - "Add a platform" → modal that adds a new integration row + pushes to Screen Guide

4. `/app/dashboard/content/page.tsx` — stub: "Your content pipeline is being set up"
5. `/app/dashboard/brand/page.tsx` — read-only view of brand profile from interview output

**Exit criteria:**
- Dashboard loads with real data for authenticated tenant
- Integrations table shows live status
- "Re-connect" triggers Screen Guide
- All four tabs render without errors

---

## Step 7 — Lux & Glo End-to-End Smoke Test

**Context:** Tenant #0. Validates the full flow before any real customer uses it.

**Tasks:**

1. Sign in with a fresh L&G account
2. Run AI interview as "Lux & Glo" — beauty media, Australia, women 25–45
3. Confirm generated integration list includes Meta Pixel, Meta Ads, Instagram
4. Run Screen Guide for each integration using the Fondpaw Business portfolio
5. Confirm all flip to `complete` in Supabase
6. Dashboard shows "All connected" state
7. Record 2-min screen capture of the full flow (for sales + investor use)
   - Save to `E:\media-studio\briolo-demo-v1.mp4`

**Exit criteria:**
- Full sign-up → interview → checklist → Screen Guide → dashboard without manual debugging
- All integration rows `complete` in Supabase
- Zero console errors in production build
- Screen capture saved

---

## Dependency Order

```
Step 1 (scaffold)
  └── Step 2 (auth + schema)
        ├── Step 3 (AI interview)    ← parallel with Step 4
        └── Step 4 (extension bridge)
              └── Step 5 (setup page)
                    └── Step 6 (dashboard shell)
                          └── Step 7 (smoke test)
```

Steps 3 and 4 run in parallel after Step 2 completes.

---

## Phase 2 Backlog

- Content pipeline tab (real pipeline status from Briolo's production system)
- Content approval flow (user approves/rejects AI-generated posts)
- Publishing integrations (Briolo posts on their behalf)
- Analytics tab (reach/engagement from connected platforms)
- Team seats (invite collaborators)
- Billing (Stripe subscription + plan limits)
- Supabase Realtime completion instead of fetch callback
- Multi-tenant admin panel for Briolo staff

---

## File Map

| File | Step |
|---|---|
| `E:\lux-and-glo\briolo-app\` (created) | 1 |
| `src\app\(auth)\login\page.tsx` | 2 |
| `src\middleware.ts` | 2 |
| `src\app\api\interview\route.ts` | 3 |
| `src\app\onboarding\page.tsx` | 3 |
| `screen-guide-browser-v1\src\manifest.json` | 4 |
| `screen-guide-browser-v1\src\background.js` | 4 |
| `src\app\api\tasks\[id]\complete\route.ts` | 4 |
| `src\lib\extension-bridge.ts` | 4 |
| `src\app\setup\page.tsx` | 5 |
| `src\app\dashboard\layout.tsx` | 6 |
| `src\app\dashboard\page.tsx` | 6 |
| `src\app\dashboard\integrations\page.tsx` | 6 |

---

*Authored: 2026-06-22. Start with Step 1.*
