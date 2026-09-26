// Bearer tokens for Azure data-plane REST calls (Batch), via the Container App's
// managed identity. Imported lazily so the AWS path never loads @azure/identity.
let credential;

export async function azureToken(scope) {
  if (!credential) {
    const { DefaultAzureCredential } = await import('@azure/identity');
    credential = new DefaultAzureCredential();
  }
  const { token } = await credential.getToken(scope);
  return token;
}
