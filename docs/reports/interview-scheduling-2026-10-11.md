# Interview scheduling and candidate messages — report

11 October 2026. Written for the HR team, in plain language.

---

## 1. What I found when I checked

**The company server.** I can't open it: it's only reachable from inside
the company network. Everything below was checked in the latest version of the
system, which is what the server shows once it's updated.

**Interviews, before this work:**

| Area | What was there |
|---|---|
| Calendar | Yes: day, week, month and list views; click an empty half hour to book |
| Booking form | Yes: type, mode, date, length, place or video link, interviewers; warns if an interviewer is already booked |
| Email invitation | Yes, sent automatically, but **the wording was fixed in the code**, so HR could not change it |
| WhatsApp | **No.** Only a "WhatsApp sender number" setting, which nothing used |
| Phone call | **No** |
| Message templates | **No** place to write or change messages |
| Reschedule | **No button.** The system could do it, but there was no way to reach it on screen |
| Telling the candidate about a change or cancellation | **No** |
| Recording the candidate's answer (confirmed / wants another time) | **No** |
| Video link in the invitation email | Shown as plain text instead of a clickable link (a small bug) |

So your concern was right: there was no field for a message to candidates,
and no WhatsApp.

## 2. The separate scheduler app (`scheduler-saas`)

I read it fully so the same work isn't done twice.

**What it already has (built and tested on a laptop):**
- A booking calendar with working hours.
- Automatic email (through a service called Resend) and automatic WhatsApp
  (through Twilio).
- A personal link for the person invited to **confirm, choose another time, or
  cancel** themselves, without an account.
- Automatic reminders (24 hours and 1 hour before).
- A delivery history: sent, delivered, read, failed.
- Editable message templates.
- A ready **connection point for other systems such as the ATS**
  (`/api/integrations/v1`).

**What it does not have yet:**
- **It is not live.** No server, no real email domain, no WhatsApp account.
  Its own checklist shows these steps are still open.
- **WhatsApp needs approval:** a WhatsApp Business account through Twilio and
  Meta-approved message templates. Twilio says this takes **3–4 weeks**.
- **No phone call option.** Its plan lists voice calls as "not in version 1".
- **The ATS is not connected to it yet.**

**Decision:** I did **not** rebuild automatic sending, reminders or the
candidate self-service link inside the ATS. The scheduler already does those,
so once it's live the ATS should connect to it. What I built in the ATS works
**today, with no new accounts**, and fits alongside the scheduler.

## 3. What I built in the ATS

**a) Message templates** (Interviews → **Message templates** button)
- Four messages: **Interview invitation**, **New interview time**, **Interview
  cancelled**, **Reminder**.
- Each has a **WhatsApp text**, a **call script** (what to say on the phone), an
  **email subject** and an **email text**.
- Click a word like `{candidate_name}`, `{date}`, `{time}` or `{where}` to add it.
  It is filled in for each candidate.
- Arabic works. A misspelt word such as `{nmae}` is refused with a clear message.
- **Use standard wording** puts a message back to the default.
- Who can edit: anyone allowed to manage notifications (HR Director, HR
  Manager, Recruitment Manager, Recruiter, and the System Admin).

**b) Booking form: "Tell the candidate"**
- Three choices: ☑ **Email** (sent automatically) ☑ **WhatsApp** ☐ **Phone call**.
- Two buttons, the same as the scheduler app:
  - **Save only:** books it without contacting the candidate.
  - **Schedule & tell candidate:** books it and opens the contact window.
- Adding a **new** candidate from this form now asks for their **mobile
  number** too.
- Type and mode now read "Technical" and "On site" instead of "technical" and
  "onsite".

**c) The contact window** (opens after booking, or from **Contact candidate**
on an interview)
- **WhatsApp:** the message is filled in and can be edited. **Open WhatsApp**
  opens your WhatsApp on that computer or phone with the text ready; you press
  Send there. **Copy text** is there too.
- **Phone call:** shows the number and a **Call** button. On a phone it dials;
  on a computer it opens your phone app or Teams. The **script** is shown in a
  box to read out.
- **Email:** subject and text are filled in and can be edited, then **Send
  email**. If no mailbox is connected, it says so plainly instead of pretending
  it sent.
- **What did the candidate say?** Four buttons: **No answer yet**, **Confirmed**,
  **Wants another time**, **Declined**.
- Egyptian numbers like `010…` get `+20` added automatically. If a CV lists
  two numbers, the first is used.

**d) On each interview page**
- New buttons: **Contact candidate** and **Reschedule**.
- **Reschedule** asks for a new date, time, length, mode and place. After you
  save, the contact window opens with the **New interview time** message.
- After a **Cancel**, the contact window opens with the **Interview cancelled**
  message.
- A **Candidate's answer** section shows and changes the answer.
- **Moving an interview resets the answer to "No answer yet"**, because they
  agreed to the old time, not the new one. This is the scheduler app's rule.
- The history shows every contact: "WhatsApp — Interview invitation opened for
  +20…", "Phone call — Called +20…", "Email — … emailed to …", "Candidate
  answer — Confirmed".

**e) Interviews list:** under the status, each upcoming interview shows the
candidate's answer, such as "Confirmed" or "No answer yet".

**f) Fixes:** the video link in the email is now clickable; the list no longer
shows an empty green tag when there is no hiring request.

## 4. Trying it as a recruiter: booking an appointment

I signed in as a recruiter (Karim Adel) and booked interviews from start to
finish, on a computer screen and on a phone screen.

| Step | What you do | Result |
|---|---|---|
| 1 | Interviews → **Schedule interview**, or click an empty half hour on the calendar | Form opens |
| 2 | Type the candidate's name, pick them | Picked |
| 3 | Pick date and time, mode, place; tap one or more interviewers | Done; warns if someone is already booked |
| 4 | Leave **Email** and **WhatsApp** ticked; press **Schedule & tell candidate** | Booked. The email goes if a mailbox is connected, and the screen says which |
| 5 | Contact window opens on WhatsApp → **Open WhatsApp** → press Send in WhatsApp | Message ready, nothing to type |
| 6 | Or **Phone call** → **Call** → read the script | Dials |
| 7 | When the candidate answers, tap **Confirmed** (or another answer) | Saved and shown in the list |

**Time:** about **one minute** from opening the form to the WhatsApp message
being ready, with no typing of the message itself.

**Problems I found while testing, all fixed:**
1. After booking it said "invitation emailed" even when no mailbox was
   connected. It now says only what really happened.
2. A new candidate added from the booking form had no phone field.
3. On a phone, the four answer buttons ran off the edge of the screen. They
   now wrap.
4. The **Call** button text was underlined.
5. Empty green tag in the list for interviews without a hiring request.

**Still to improve (not done yet):**
- **No automatic reminders.** You send a reminder from the contact window
  yourself. Automatic reminders belong to the scheduler app once it's live.
- **The candidate can't confirm by link yet.** That's also the scheduler's
  job.
- WhatsApp opening on your device means **you** press Send. Fully automatic
  WhatsApp needs the WhatsApp Business approval described above.
- The "Tell the candidate" choices are at the bottom of the booking form, so
  on a small laptop screen you scroll down once to see them.

## 5. Checks

- 41 new automatic checks for messages, templates, calls and answers: all pass.
- The full test suite: all pass, except the one old check that only fails in
  my cloud workspace.
- Every new screen was opened in a browser on a computer and a phone, with no
  errors.

## 6. What I need from you

1. **Approve the change request** with this work, then the company server
   update (same steps as before).
2. **Scheduler app:**
   - Should it also get the **phone call option with a script**? Its plan
     currently says no calls in version 1.
   - Do you want to start the WhatsApp Business / Twilio application now,
     given the 3–4 weeks of approval?
3. **Mailbox:** connect the recruitment mailbox under **Email & Mailbox** so
   invitations and emails actually go out.
