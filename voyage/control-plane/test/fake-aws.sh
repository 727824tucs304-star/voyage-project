#!/bin/sh
# TEST DOUBLE for the AWS CLI "ce get-cost-and-usage" call. Output has the same JSON shape as Cost Explorer.
# If the file named by AWS_MODE_FILE contains "denied", it fails the way missing AWS permissions would.
if [ -n "$AWS_MODE_FILE" ] && grep -q denied "$AWS_MODE_FILE" 2>/dev/null; then
  echo "An error occurred (AccessDenied) when calling the GetCostAndUsage operation: not authorized" >&2
  exit 255
fi
m=$(date -u +%Y-%m-01)
cat <<JSON
{"ResultsByTime":[{"TimePeriod":{"Start":"$m","End":"$m"},"Estimated":false,"Groups":[
{"Keys":["Amazon Elastic Compute Cloud - Compute"],"Metrics":{"UnblendedCost":{"Amount":"12.5","Unit":"USD"}}},
{"Keys":["EC2 - Other"],"Metrics":{"UnblendedCost":{"Amount":"3.0","Unit":"USD"}}},
{"Keys":["AWS Data Transfer"],"Metrics":{"UnblendedCost":{"Amount":"1.5","Unit":"USD"}}},
{"Keys":["Amazon Route 53"],"Metrics":{"UnblendedCost":{"Amount":"0.5","Unit":"USD"}}}],"Total":{}}]}
JSON
