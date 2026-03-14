# Deploy secrets (after a leak)

1. **Rotate MongoDB Atlas password**  
   Atlas → Database Access → user → Edit → new password. The old password was in public Git history and must be treated as compromised.

2. **Local deploy only**  
   - Copy `deploy.env.example` → `.env.deploy` (never committed).  
   - Put the **new** `MONGO_URI` there.  
   - Run `./deploy.sh` from your machine only.

3. **GitHub security alert**  
   After rotating: in the alert, choose **revoke** / close as resolved once the old credential is disabled.

4. **Optional: remove secret from Git history**  
   The string may still exist in old commits. To purge (rewrites history — coordinate with team):  
   [GitHub: Removing sensitive data](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)

5. **Related repo**  
   If the same URI appeared in `rithikareddy-bit/vmaf` (or elsewhere), fix and rotate there too.
