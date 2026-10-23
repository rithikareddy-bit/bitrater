# Non-secret settings for azure-infra (secrets live only in Key Vault).
# Current Stage 1: shadow apps enabled and live; prod disabled (see variables.tf defaults).

# Exact ubuntu-hpc 2204 marketplace version (newest on 2026-09-27). A3 confirms Batch lists it
# as container-capable: `az batch pool supported-images list --account-name bitraterbatchshadow ...`
batch_image_version = "22.04.2026082801"

# Immutable images built in ACR on 2026-09-27 (az acr build from minimal contexts). dashboard/lab/visqol rebuilt after
# the e2e review (isolation check in lib/mongodb.js + /api/health; best-effort S3 key in azure_entry.py); jobs rebuilt 20261006b (resign_guard null episode_id fix).
# Workers are wrappers on the exact ECR-imported prod images (chai-q-worker@sha256:3980..., audio-visqol-worker@sha256:0e9e...).
images = { # rebuilt 2026-10-06 (tag 20261006) with the Oct-6 fixes
  dashboard = "bitrater-dashboard@sha256:f54e6e695c5f9ab32a98fcb93bb5acdd590875c45cdf9259be421dbf2c60b10c"
  jobs      = "bitrater-jobs@sha256:96cbae820898c2274373d4341f0970257913a479aa8f6c68ab08d3862d372f03"
  lab       = "chai-q-worker-azure@sha256:24a7a566a839ffdc14ee2b1334597ceb7009325d4c7cf776bcadcd64b86aefb5"
  visqol    = "audio-visqol-azure@sha256:21a5661859a3f26698b7ac1a9d0b01f055ccf0359e5490f4412801d1862b803d"
}

# Stage 1 (2026-10-06): shadow dashboard login + alerts (owner-approved). Not secrets.
entra_client_id = "d7e4b4de-eb13-4307-9259-21f25fc57278" # app reg bitrater-dashboard-shadow
alert_email     = "rithikaabba@chaishots.in"
dashboard_allowed_principals = {
  identities = ["39a6a5f6-8556-4700-9c7e-be6dad0e94be"] # rithika_dev@krishnachaishots.onmicrosoft.com
  groups     = []
}
