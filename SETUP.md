# Connecting Hooky to a real backend

This takes about five minutes. Do steps 1 and 2, then hand me the two values
from step 3 and I'll do the rest.

## 1. Create a free project

1. Go to https://supabase.com and sign in with the same account the assistant is
   connected to, so it can apply the database schema for you.
2. Your existing organization ("Pixel Theory CURRENT") charges $10/month per
   project, so **make a new organization** instead. On the new-project screen,
   open the organization dropdown and choose **New organization**. Pick the
   **Free** plan.
3. Create a project inside that new organization.
   - Name: `hooky`
   - Database password: let it generate one. You do not need it for the app, but
     save it somewhere in case you want direct database access later.
   - Region: pick the one closest to you.
4. Wait for it to finish provisioning, about two minutes.

## 2. Turn on email sign-in

Hooky signs people in with a six-digit code sent by email. No passwords.

1. In the project, go to **Authentication → Sign In / Providers**.
2. Make sure **Email** is enabled.
3. Turn **Confirm email** on, and turn **Enable email OTP** on if it is listed
   separately. This is what sends the six-digit code.

> The built-in email service is rate-limited to a handful of messages per hour
> and is meant for testing only. It is fine while you try the app out. Before
> real users, connect your own SMTP provider under **Authentication → Emails**.

## 3. Send me these two values

In the project, go to **Project Settings → API** (or **API Keys**) and copy:

- **Project URL**, which looks like `https://abcdefghijklm.supabase.co`
- **Publishable key** (`sb_publishable_...`), or the legacy **anon** key if
  that is what your project shows

Paste both to me and I will apply the schema, wire up the config, push it, and
test the live site end to end.

### Which keys are safe to share

| Key | Safe in public code? | Why |
| --- | --- | --- |
| Publishable / anon | Yes | It only permits what Row Level Security allows. Every shipped web and mobile app contains one. |
| `service_role` / secret | **Never** | It bypasses Row Level Security entirely and can read and delete every user's data. |

Hooky's `config.js` is committed to the repository so the live GitHub Pages site
can use it. That is fine for the publishable key and only the publishable key.
If a secret key ever lands in this repository, rotate it immediately in
**Project Settings → API Keys**.

## 4. What I will do next

1. Apply `supabase/schema.sql`: tables, Row Level Security, and the functions
   that enforce age brackets and message filtering on the server.
2. Run Supabase's security advisor and fix anything it flags.
3. Write `config.js`, commit, and push so the live site switches out of demo mode.
4. Create a test account and verify sign-in, the age gate, matching, chat
   filtering, and presence against the real database.

## Still required before real users

The schema applies cleanly and enforces the safety rules, but three things are
deliberately left as placeholders, each marked in `supabase/schema.sql`:

- **Age verification** is self-reported. `complete_age_check()` marks an account
  as checked when the client says the selfie step ran. A modified client could
  call it directly. Replace it with a callback from a real age-estimation vendor.
- **Photo moderation** does not exist. Photos are stored as data URLs on the
  profile with no classifier in front of them.
- **Payments** are not wired. `premium_until` is only writable by trusted server
  code, so Hooky+ stays off until a store webhook sets it.
