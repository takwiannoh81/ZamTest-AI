#!/usr/bin/env bash
# Sets up S3 backups for ZamTech AI. Run it in AWS CloudShell (already signed
# in as you, so no keys need to be copied around):
#
#   1. Creates a private, versioned, encrypted bucket (if it doesn't exist).
#   2. Creates the IAM policy "zamtech-backups" limited to that bucket's zamtest/ folder.
#   3. Creates the IAM user "zamtech-backup" with only that policy, and an access key.
#   4. Prints ONE block to paste into the Lightsail server terminal.
#
# Safe to re-run; existing resources are reused.
set -euo pipefail

REGION="${REGION:-us-east-2}"
PREFIX="zamtest/"
POLICY_NAME="zamtech-backups"
USER_NAME="zamtech-backup"
EXPOSED_KEY_ID="${EXPOSED_KEY_ID:-}"  # optional: an access key ID that was exposed and should be deactivated

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="${BUCKET:-zamtechai-backups-$ACCOUNT}"
echo "AWS account $ACCOUNT, region $REGION, bucket $BUCKET"

# 1. Bucket --------------------------------------------------------------
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "Bucket exists."
else
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  echo "Bucket created."
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
# Old versions of deleted backups disappear after 30 days, so storage stays small.
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration \
  '{"Rules":[{"ID":"expire-old-versions","Status":"Enabled","Filter":{"Prefix":"'"$PREFIX"'"},"NoncurrentVersionExpiration":{"NoncurrentDays":30},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}'
echo "Bucket locked down: private, versioned, encrypted."

# 2. Policy limited to this bucket folder --------------------------------
POLICY_DOC=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ListBackups", "Effect": "Allow", "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::$BUCKET",
      "Condition": { "StringLike": { "s3:prefix": ["${PREFIX}*"] } } },
    { "Sid": "ReadWriteBackups", "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::$BUCKET/${PREFIX}*" }
  ]
}
JSON
)
POLICY_ARN="arn:aws:iam::$ACCOUNT:policy/$POLICY_NAME"
if aws iam get-policy --policy-arn "$POLICY_ARN" >/dev/null 2>&1; then
  # Keep at most 5 versions (AWS limit): drop the oldest non-default one first.
  OLD=$(aws iam list-policy-versions --policy-arn "$POLICY_ARN" \
    --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text | awk '{print $NF}')
  COUNT=$(aws iam list-policy-versions --policy-arn "$POLICY_ARN" --query 'length(Versions)' --output text)
  if [ "$COUNT" -ge 5 ] && [ -n "$OLD" ]; then aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id "$OLD"; fi
  aws iam create-policy-version --policy-arn "$POLICY_ARN" --policy-document "$POLICY_DOC" --set-as-default >/dev/null
  echo "Policy $POLICY_NAME updated."
else
  aws iam create-policy --policy-name "$POLICY_NAME" --policy-document "$POLICY_DOC" \
    --description "ZamTech AI backups: only s3://$BUCKET/$PREFIX" >/dev/null
  echo "Policy $POLICY_NAME created."
fi

# 3. User with only that policy, plus an access key ----------------------
if ! aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then
  aws iam create-user --user-name "$USER_NAME" >/dev/null
  echo "User $USER_NAME created."
fi
aws iam attach-user-policy --user-name "$USER_NAME" --policy-arn "$POLICY_ARN"
KEYS=$(aws iam list-access-keys --user-name "$USER_NAME" --query 'length(AccessKeyMetadata)' --output text)
if [ "$KEYS" -ge 2 ]; then
  echo "User $USER_NAME already has 2 access keys (the AWS maximum). Delete one in IAM and run this again." >&2
  exit 1
fi
read -r KEY_ID KEY_SECRET < <(aws iam create-access-key --user-name "$USER_NAME" \
  --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)
echo "Access key created for $USER_NAME."

# 4. Optional: deactivate the key that was shared in chat -----------------
if [ -n "$EXPOSED_KEY_ID" ] && OWNER=$(aws iam get-access-key-last-used --access-key-id "$EXPOSED_KEY_ID" --query UserName --output text 2>/dev/null) \
  && [ -n "$OWNER" ] && [ "$OWNER" != "None" ]; then
  printf '\nThe key %s (user %s) was pasted into a chat and should not be used anymore.\nDeactivate it now? It can be re-activated in IAM if something breaks. [y/N] ' "$EXPOSED_KEY_ID" "$OWNER"
  read -r answer < /dev/tty || answer=""
  if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
    aws iam update-access-key --user-name "$OWNER" --access-key-id "$EXPOSED_KEY_ID" --status Inactive
    echo "Deactivated $EXPOSED_KEY_ID. Delete it in IAM once you're sure nothing uses it."
  fi
fi

cat <<OUT

================================================================================
 Done. Now open the Lightsail terminal (Connect using SSH) and paste EVERYTHING
 between the two lines below:
--------------------------------------------------------------------------------
cd ~/ZamTest-AI/deploy && sudo sed -i '/^ZAMTEST_BACKUP_S3_/d;/^AWS_ACCESS_KEY_ID=/d;/^AWS_SECRET_ACCESS_KEY=/d' .env && sudo tee -a .env >/dev/null <<'ENV'
ZAMTEST_BACKUP_S3_BUCKET=$BUCKET
ZAMTEST_BACKUP_S3_REGION=$REGION
AWS_ACCESS_KEY_ID=$KEY_ID
AWS_SECRET_ACCESS_KEY=$KEY_SECRET
ENV
sudo bash ~/ZamTest-AI/deploy/install.sh && sudo bash ~/ZamTest-AI/deploy/backup-now.sh
--------------------------------------------------------------------------------
 The secret key is shown only here. Don't save it anywhere else.
================================================================================
OUT
