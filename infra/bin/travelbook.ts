#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BootstrapStack, REGION } from '../lib/bootstrap-stack';
import { TravelBookStack } from '../lib/travelbook-stack';

const app = new cdk.App();

// One-time, human-reviewed bootstrap (CloudShell): artifact bucket, GitHub
// OIDC provider, deploy role, CloudFormation execution role.
const bootstrap = new BootstrapStack(app, 'TravelBookBootstrap', {
  stackName: 'travelbook-bootstrap',
  env: { region: REGION },
  description: 'TravelBook bootstrap: artifact bucket, GitHub OIDC, deploy + CFN execution roles',
});

// The application stack. Deployed by GitHub Actions via OIDC.
new TravelBookStack(app, 'TravelBookDev', {
  stackName: 'travelbook-dev',
  env: { region: REGION },
  description: 'TravelBook dev stack — serverless, free-tier only, us-west-2',
  deployRoleArn: bootstrap.deployRole.roleArn,
});
