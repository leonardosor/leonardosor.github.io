#!/bin/bash

# Set AWS CLI Configuration
export AWS_REGION="us-west-2"         # Specify your AWS region (e.g., us-west-2)
export AWS_ACCESS_KEY_ID="your-access-key-id" # Replace with your AWS access key ID
export AWS_SECRET_ACCESS_KEY="your-secret-access-key" # Replace with your AWS secret key

# Set Bedrock-Specific Resources (Update these as required)
export BEDROCK_MODEL_ID="amazon.titan-tg1-large" # Replace with your chosen model ID
export API_GATEWAY_URL="https://your-api-gateway-endpoint" # Replace with API Gateway endpoint
export MAX_TOKENS=100
export TEMPERATURE=0.7

echo "AWS CLI configuration is set."