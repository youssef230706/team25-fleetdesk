# Team guide: how we work in this repository

## The rules
1. **Never push to `main`.** `main` is protected: changes only arrive through a pull request (PR).
2. **Work on your own branch**, named after your part:
   - Kareem: `fleet/<what>`   for example `fleet/user-management`
   - Youssef: `booking/<what>` for example `booking/edit-booking`
   - Ziad: `trips/<what>`     for example `trips/estimate-vs-actual`
3. **Only change your own folder and pages.** Shared files (`frontend/js/api.js`, `frontend/js/config.js`,
   `frontend/css/style.css`, the top menu, `floci/`) need the owner's review: GitHub asks for it automatically
   (see `.github/CODEOWNERS`).
4. **Every PR needs one approval from a teammate and green tests** before it can be merged.
5. **Never commit `.env`, passwords or keys.** `.gitignore` blocks them and the tests run a secret scan.

## Every time you start working

```powershell
git checkout main
git pull
git checkout -b booking/my-change        # your own prefix
```

## When your change is ready

```powershell
git status                                # check that no .env file is listed
git add <your folder and pages>
git commit -m "Booking: short description of the change"
git push -u origin booking/my-change
```

Then on GitHub: **Compare & pull request** → describe what changed and how you tested it → **Create pull request**.
A teammate reviews it, the tests run automatically, and after approval the author clicks **Squash and merge**.

## Keeping your branch up to date

```powershell
git checkout main
git pull
git checkout booking/my-change
git merge main
```

## After a merge: deploy and test on Floci

```powershell
git checkout main
git pull
cd floci
npm run deploy
```

## Contracts between services
- Fleet: `docs/fleet-api.md` (Kareem)
- Booking: `docs/booking-api.md` (Youssef)
- Trip: `docs/trip-api.md` (Ziad)

Change your contract in the same PR as the code, and tell the others in the PR description.
