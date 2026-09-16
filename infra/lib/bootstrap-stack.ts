import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export const REGION = 'us-west-2';
export const PROJECT = 'travelbook';
export const GITHUB_REPO = 'kiranbadam/travelbook';

/**
 * Statements shared by the GitHub deploy role and the CloudFormation execution
 * role. Scoped to the TravelBook stacks only; no iam:CreateUser/CreateAccessKey
 * anywhere.
 */
export function deploymentPolicyStatements(scope: Construct): iam.PolicyStatement[] {
  const account = cdk.Stack.of(scope).account;
  const r = REGION;
  return [
    // CloudFormation on the two TravelBook stacks only.
    new iam.PolicyStatement({
      sid: 'CloudFormationTravelBookStacks',
      actions: ['cloudformation:*'],
      resources: [
        `arn:aws:cloudformation:${r}:${account}:stack/${PROJECT}-bootstrap/*`,
        `arn:aws:cloudformation:${r}:${account}:stack/${PROJECT}-dev/*`,
      ],
    }),
    // PassRole only for travelbook-prefixed service roles (Lambda execution,
    // scheduler, CFN exec). Includes the CFN exec role itself so the deploy
    // role can hand it to CloudFormation via --role-arn.
    new iam.PolicyStatement({
      sid: 'PassServiceRoles',
      actions: ['iam:PassRole'],
      resources: [`arn:aws:iam::${account}:role/${PROJECT}-*`],
    }),
    // Managed policies CFN creates for the Lambda execution roles
    // (AWS::IAM::Policy resources). Without these, attaching the
    // DefaultPolicy documents fails.
    new iam.PolicyStatement({
      sid: 'ManageTravelBookManagedPolicies',
      actions: [
        'iam:CreatePolicy',
        'iam:DeletePolicy',
        'iam:GetPolicy',
        'iam:GetPolicyVersion',
        'iam:ListPolicyVersions',
        'iam:CreatePolicyVersion',
        'iam:DeletePolicyVersion',
        'iam:TagPolicy',
        'iam:UntagPolicy',
      ],
      resources: [`arn:aws:iam::${account}:policy/${PROJECT}-*`],
    }),
    new iam.PolicyStatement({
      sid: 'Lambda',
      actions: ['lambda:*'],
      resources: [
        `arn:aws:lambda:${r}:${account}:function:${PROJECT}-*`,
        // CreateEventSourceMapping addresses the mapping ARN, not the function.
        `arn:aws:lambda:${r}:${account}:event-source-mapping:*`,
      ],
    }),
    new iam.PolicyStatement({
      sid: 'ApiGateway',
      actions: ['apigateway:*'],
      // /tags/* is required: creating a tagged HTTP API issues
      // POST /tags/<api-arn> in addition to POST /v2/apis.
      resources: [
        `arn:aws:apigateway:${r}::/apis`,
        `arn:aws:apigateway:${r}::/apis/*`,
        `arn:aws:apigateway:${r}::/tags/*`,
      ],
    }),
    new iam.PolicyStatement({
      sid: 'DynamoDB',
      actions: ['dynamodb:*'],
      resources: [`arn:aws:dynamodb:${r}:${account}:table/${PROJECT}`],
    }),
    new iam.PolicyStatement({
      sid: 'S3TravelBookBuckets',
      actions: ['s3:*'],
      resources: [`arn:aws:s3:::${PROJECT}-*`, `arn:aws:s3:::${PROJECT}-*/*`],
    }),
    new iam.PolicyStatement({
      sid: 'CloudFront',
      actions: ['cloudfront:*'],
      resources: [
        `arn:aws:cloudfront::${account}:distribution/*`,
        `arn:aws:cloudfront::${account}:origin-access-control/*`,
        `arn:aws:cloudfront::${account}:function/*`,
        `arn:aws:cloudfront::${account}:cache-policy/*`,
        `arn:aws:cloudfront::${account}:origin-request-policy/*`,
      ],
    }),
    new iam.PolicyStatement({
      sid: 'Cognito',
      actions: ['cognito-idp:*'],
      resources: [`arn:aws:cognito-idp:${r}:${account}:userpool/*`],
    }),
    new iam.PolicyStatement({
      sid: 'SQS',
      actions: ['sqs:*'],
      resources: [`arn:aws:sqs:${r}:${account}:${PROJECT}-*`],
    }),
    new iam.PolicyStatement({
      sid: 'SSMParameters',
      actions: ['ssm:*'],
      resources: [`arn:aws:ssm:${r}:${account}:parameter/${PROJECT}/dev/*`],
    }),
    new iam.PolicyStatement({
      sid: 'Scheduler',
      actions: ['scheduler:*'],
      resources: [`arn:aws:scheduler:${r}:${account}:schedule/*/${PROJECT}-*`],
    }),
    new iam.PolicyStatement({
      sid: 'Logs',
      actions: ['logs:*'],
      resources: [`arn:aws:logs:${r}:${account}:log-group:/aws/lambda/${PROJECT}-*:*`],
    }),
    new iam.PolicyStatement({
      sid: 'CloudWatchAlarms',
      actions: ['cloudwatch:*'],
      resources: [`arn:aws:cloudwatch:${r}:${account}:alarm:${PROJECT}-*`],
    }),
    // Required for `cdk deploy` asset staging. The CDK toolkit bucket/params
    // are not travelbook-prefixed; this is the smallest workable scope.
    new iam.PolicyStatement({
      sid: 'CdkBootstrapAssets',
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket', 's3:GetBucketLocation', 's3:AbortMultipartUpload'],
      resources: [
        `arn:aws:s3:::cdk-*-assets-${account}-${r}`,
        `arn:aws:s3:::cdk-*-assets-${account}-${r}/*`,
      ],
    }),
    // CloudFormation resolves template parameters of type
    // AWS::SSM::Parameter::Value<String> with ssm:GetParameters (plural),
    // so both actions are needed for the CFN execution role.
    new iam.PolicyStatement({
      sid: 'CdkBootstrapLookup',
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${r}:${account}:parameter/cdk-bootstrap/*`],
    }),
    new iam.PolicyStatement({
      sid: 'CdkToolkitDescribe',
      actions: ['cloudformation:DescribeStacks'],
      resources: [`arn:aws:cloudformation:${r}:${account}:stack/CDKToolkit/*`],
    }),
  ];
}

export class BootstrapStack extends cdk.Stack {
  public readonly deployRole: iam.Role;
  public readonly cfnExecRole: iam.Role;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    cdk.Tags.of(this).add('project', PROJECT);

    // Private, versioned deployment-artifact bucket.
    const artifacts = new s3.Bucket(this, 'Artifacts', {
      bucketName: `${PROJECT}-artifacts-${cdk.Stack.of(this).account}-${REGION}`,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'expire-noncurrent-versions',
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
    });

    // GitHub OIDC provider. CDK resolves the thumbprint via a deploy-time
    // custom resource; nothing to hardcode.
    const oidcProvider = new iam.OpenIdConnectProvider(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    const baseStatements = deploymentPolicyStatements(this);

    // Least-privilege role assumed by GitHub Actions via OIDC, bound to the
    // main branch of kiranbadam/travelbook.
    this.deployRole = new iam.Role(this, 'DeployRole', {
      roleName: `${PROJECT}-github-deploy`,
      assumedBy: new iam.FederatedPrincipal(
        oidcProvider.openIdConnectProviderArn,
        {
          StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
          StringLike: { 'token.actions.githubusercontent.com:sub': `repo:${GITHUB_REPO}:ref:refs/heads/main` },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      inlinePolicies: {
        TravelBookDeploy: new iam.PolicyDocument({ statements: baseStatements }),
      },
    });

    // Role CloudFormation assumes to execute the TravelBook stacks. Same
    // scoped policy as the deploy role, PLUS IAM role-lifecycle rights on
    // travelbook-* roles: without them CloudFormation cannot create the
    // Lambda execution roles and the scheduler role in travelbook-dev.
    // (Deviation from a literal "same policy" reading — see README.)
    this.cfnExecRole = new iam.Role(this, 'CfnExecRole', {
      roleName: `${PROJECT}-cfn-exec`,
      assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
      inlinePolicies: {
        TravelBookDeploy: new iam.PolicyDocument({ statements: baseStatements }),
        RoleLifecycle: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'ManageTravelBookServiceRoles',
              actions: [
                'iam:CreateRole',
                'iam:DeleteRole',
                'iam:GetRole',
                'iam:UpdateRole',
                'iam:UpdateAssumeRolePolicy',
                'iam:PutRolePolicy',
                'iam:GetRolePolicy',
                'iam:DeleteRolePolicy',
                'iam:AttachRolePolicy',
                'iam:DetachRolePolicy',
                'iam:TagRole',
                'iam:UntagRole',
                'iam:ListRolePolicies',
                'iam:ListAttachedRolePolicies',
              ],
              resources: [`arn:aws:iam::${cdk.Stack.of(this).account}:role/${PROJECT}-*`],
            }),
          ],
        }),
      },
    });

    new cdk.CfnOutput(this, 'ArtifactBucketName', { value: artifacts.bucketName });
    new cdk.CfnOutput(this, 'DeployRoleArn', { value: this.deployRole.roleArn });
    new cdk.CfnOutput(this, 'CfnExecRoleArn', { value: this.cfnExecRole.roleArn });
    new cdk.CfnOutput(this, 'OidcProviderArn', { value: oidcProvider.openIdConnectProviderArn });
  }
}
