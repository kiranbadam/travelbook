import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { PROJECT, REGION } from './bootstrap-stack';

export interface TravelBookStackProps extends cdk.StackProps {
  /** ARN of the travelbook-github-deploy role (from the bootstrap stack), echoed as an output. */
  readonly deployRoleArn: string;
}

/** DynamoDB actions the functions are allowed. The plan's "ConditionCheck"
 *  maps to the real IAM action dynamodb:ConditionCheckItem. */
const TABLE_ACTIONS = [
  'dynamodb:GetItem',
  'dynamodb:PutItem',
  'dynamodb:UpdateItem',
  'dynamodb:Query',
  'dynamodb:TransactWriteItems',
  'dynamodb:ConditionCheckItem',
];

export class TravelBookStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TravelBookStackProps) {
    super(scope, id, props);
    cdk.Tags.of(this).add('project', PROJECT);

    const account = cdk.Stack.of(this).account;

    // ------------------------------------------------------------------
    // DynamoDB — single table, fixed provisioned capacity, no autoscaling.
    // ------------------------------------------------------------------
    const table = new dynamodb.Table(this, 'Table', {
      tableName: PROJECT,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 5,
      writeCapacity: 5,
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.DEFAULT, // AWS-owned key (default)
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev stack
    });
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
      readCapacity: 5,
      writeCapacity: 5,
    });
    table.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'gsi2pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi2sk', type: dynamodb.AttributeType.STRING },
      // INCLUDE (not KEYS_ONLY): the backend's one-active-job guard filters
      // by owner server-side, so owner/state must be projected.
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['owner', 'state'],
      readCapacity: 5,
      writeCapacity: 5,
    });

    // ------------------------------------------------------------------
    // SQS — feed job queue with DLQ. Max 2 receives, then dead-letter.
    // ------------------------------------------------------------------
    const dlq = new sqs.Queue(this, 'FeedJobsDlq', {
      queueName: `${PROJECT}-feed-jobs-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });
    const queue = new sqs.Queue(this, 'FeedJobs', {
      queueName: `${PROJECT}-feed-jobs`,
      visibilityTimeout: cdk.Duration.seconds(1200),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: { maxReceiveCount: 2, queue: dlq },
    });

    // ------------------------------------------------------------------
    // Lambda execution roles (explicit travelbook-prefixed names so the
    // deploy/CFN roles' iam:PassRole scope covers them).
    // ------------------------------------------------------------------
    const lambdaBasic = iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole');
    const apiRole = new iam.Role(this, 'ApiRole', {
      roleName: `${PROJECT}-api-fn`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [lambdaBasic],
    });
    const workerRole = new iam.Role(this, 'WorkerRole', {
      roleName: `${PROJECT}-worker-fn`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [lambdaBasic],
    });

    const tableArns = [table.tableArn, `${table.tableArn}/index/*`];
    apiRole.addToPolicy(
      new iam.PolicyStatement({ actions: TABLE_ACTIONS, resources: tableArns }),
    );
    apiRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [queue.queueArn] }),
    );
    workerRole.addToPolicy(
      new iam.PolicyStatement({ actions: TABLE_ACTIONS, resources: tableArns }),
    );
    workerRole.addToPolicy(
      new iam.PolicyStatement({
        // Receive/Delete/GetAttributes for the SQS event source; SendMessage
        // for the worker's delayed-requeue path.
        actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:SendMessage'],
        resources: [queue.queueArn],
      }),
    );
    workerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${REGION}:${account}:parameter/${PROJECT}/dev/*`],
      }),
    );

    // ------------------------------------------------------------------
    // Lambda functions. Entries are backend-owned; minimal stubs are
    // created by this repo so `cdk synth` works before the backend lands.
    // ------------------------------------------------------------------
    const apiLogGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: `/aws/lambda/${PROJECT}-api`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const workerLogGroup = new logs.LogGroup(this, 'WorkerLogGroup', {
      logGroupName: `/aws/lambda/${PROJECT}-worker`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const apiFn = new lambdaNode.NodejsFunction(this, 'ApiFunction', {
      functionName: `${PROJECT}-api`,
      // Infra-owned shim re-exporting backend/src/api/index.ts (see lambda-entries/).
      entry: path.join(__dirname, '..', 'lambda-entries', 'api.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      role: apiRole,
      logGroup: apiLogGroup,
      environment: {
        TABLE_NAME: table.tableName,
        FEED_QUEUE_URL: queue.queueUrl,
        SSM_PREFIX: `/${PROJECT}/dev`,
      },
    });
    const workerFn = new lambdaNode.NodejsFunction(this, 'WorkerFunction', {
      functionName: `${PROJECT}-worker`,
      // Infra-owned shim re-exporting backend/src/worker/index.ts (see lambda-entries/).
      entry: path.join(__dirname, '..', 'lambda-entries', 'worker.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(180),
      reservedConcurrentExecutions: 2,
      role: workerRole,
      logGroup: workerLogGroup,
      environment: {
        TABLE_NAME: table.tableName,
        FEED_QUEUE_URL: queue.queueUrl,
        SSM_PREFIX: `/${PROJECT}/dev`,
      },
    });
    workerFn.addEventSource(
      new lambdaSources.SqsEventSource(queue, { batchSize: 1, enabled: true }),
    );

    // ------------------------------------------------------------------
    // Cognito — email sign-in, no MFA, no hosted UI / OAuth.
    // ------------------------------------------------------------------
    const userPool = new cognito.UserPool(this, 'Users', {
      userPoolName: `${PROJECT}-users`,
      signInAliases: { email: true },
      autoVerify: { email: true },
      selfSignUpEnabled: true,
      mfa: cognito.Mfa.OFF,
      standardAttributes: { email: { required: true, mutable: true } },
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev stack
    });
    const userPoolClient = userPool.addClient('WebClient', {
      userPoolClientName: `${PROJECT}-web-client`,
      generateSecret: false,
      authFlows: { userPassword: true, userSrp: true },
    });
    // Alpha-only: API resolves a friend-request recipient's sub by email.
    apiRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:ListUsers'],
        resources: [userPool.userPoolArn],
      }),
    );
    apiFn.addEnvironment('USER_POOL_ID', userPool.userPoolId);

    // ------------------------------------------------------------------
    // HTTP API — JWT authorizer on every route except GET /health.
    // Stage-level throttling is the edge rate-control substitute
    // (no WAF WebACL — see README).
    // ------------------------------------------------------------------
    const jwtAuthorizer = new authorizers.HttpJwtAuthorizer(
      'JwtAuthorizer',
      `https://cognito-idp.${REGION}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [userPoolClient.userPoolClientId], authorizerName: `${PROJECT}-jwt` },
    );
    const api = new apigwv2.HttpApi(this, 'Api', {
      apiName: `${PROJECT}-api`,
      // The default stage is created explicitly below so we can set
      // stage-level throttling (the plan's edge rate-control substitute).
      createDefaultStage: false,
    });
    const apiIntegration = new integrations.HttpLambdaIntegration('ApiIntegration', apiFn);
    const jwtRoutes: Array<{ path: string; methods: apigwv2.HttpMethod[] }> = [
      { path: '/v1/preferences', methods: [apigwv2.HttpMethod.PUT] },
      { path: '/v1/feed-jobs', methods: [apigwv2.HttpMethod.POST] },
      { path: '/v1/feed-jobs/{id}', methods: [apigwv2.HttpMethod.GET] },
      { path: '/v1/feed', methods: [apigwv2.HttpMethod.GET] },
      { path: '/v1/destinations/{id}', methods: [apigwv2.HttpMethod.GET] },
      { path: '/v1/reactions', methods: [apigwv2.HttpMethod.POST] },
      { path: '/v1/trips', methods: [apigwv2.HttpMethod.POST] },
      { path: '/v1/trips', methods: [apigwv2.HttpMethod.GET] },
      { path: '/v1/trips/{id}', methods: [apigwv2.HttpMethod.GET] },
      { path: '/v1/trips/{id}/votes/me', methods: [apigwv2.HttpMethod.PUT] },
      { path: '/v1/trips/{id}/members', methods: [apigwv2.HttpMethod.POST] },
      { path: '/v1/friends', methods: [apigwv2.HttpMethod.GET] },
      { path: '/v1/friends/requests', methods: [apigwv2.HttpMethod.POST] },
      { path: '/v1/friends/requests/incoming', methods: [apigwv2.HttpMethod.GET] },
      { path: '/v1/friends/accept', methods: [apigwv2.HttpMethod.POST] },
      { path: '/v1/friends/{id}/feed', methods: [apigwv2.HttpMethod.GET] },
      { path: '/v1/feed/share', methods: [apigwv2.HttpMethod.POST] },
      { path: '/v1/trips/{id}/recommendations', methods: [apigwv2.HttpMethod.GET] },
    ];
    for (const r of jwtRoutes) {
      api.addRoutes({ path: r.path, methods: r.methods, integration: apiIntegration, authorizer: jwtAuthorizer });
    }
    api.addRoutes({
      path: '/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: apiIntegration,
    });
    // Explicit $default stage: stage-level throttling is the edge
    // rate-control substitute (no WAF WebACL — see README).
    const defaultStage = new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi: api,
      stageName: '$default',
      autoDeploy: true,
      throttle: { burstLimit: 40, rateLimit: 20 },
    });

    // ------------------------------------------------------------------
    // SSM parameters. Secrets are SecureString with the AWS-owned key;
    // values are placeholders until the coordinator sets real ones.
    // ------------------------------------------------------------------
    const ssmParams: Array<{ id: string; name: string; value: string; secure: boolean }> = [
      { id: 'TicketmasterKey', name: `/${PROJECT}/dev/ticketmaster/api-key`, value: 'UNSET', secure: true },
      { id: 'LlmProvider', name: `/${PROJECT}/dev/llm/provider`, value: 'template', secure: false },
      { id: 'LlmApiKey', name: `/${PROJECT}/dev/llm/api-key`, value: 'UNSET', secure: true },
      { id: 'DuffelMode', name: `/${PROJECT}/dev/duffel/mode`, value: 'mock', secure: false },
    ];
    for (const p of ssmParams) {
      new ssm.StringParameter(this, p.id, {
        parameterName: p.name,
        stringValue: p.value,
        type: p.secure ? ssm.ParameterType.SECURE_STRING : ssm.ParameterType.STRING,
        description: `TravelBook dev placeholder — set a real value before enabling providers.`,
      });
    }

    // ------------------------------------------------------------------
    // EventBridge Scheduler — disabled until providers are configured.
    // ------------------------------------------------------------------
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      roleName: `${PROJECT}-scheduler-exec`,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      inlinePolicies: {
        QueueSend: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [queue.queueArn] }),
          ],
        }),
      },
    });
    new scheduler.CfnSchedule(this, 'AdvisoryRefresh', {
      name: `${PROJECT}-advisory-refresh`,
      description: 'Coarse advisory refresh. DISABLED until providers are configured.',
      state: 'DISABLED',
      scheduleExpression: 'rate(6 hours)',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: queue.queueArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ type: 'advisory-refresh' }),
      },
    });

    // ------------------------------------------------------------------
    // Frontend — private S3 + CloudFront (OAC). /api/* proxies to the
    // HTTP API; a CloudFront Function strips the /api prefix because the
    // API's routes are /v1/*, not /api/v1/*.
    // ------------------------------------------------------------------
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      bucketName: `${PROJECT}-web-${account}-${REGION}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // CI redeploys assets; keep the bucket on stack delete
    });

    const stripApiPrefix = new cloudfront.Function(this, 'StripApiPrefix', {
      functionName: `${PROJECT}-strip-api-prefix`,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  if (request.uri.startsWith('/api/')) {
    request.uri = request.uri.substring(4);
  }
  return request;
}`.trim()),
    });

    const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      comment: `${PROJECT} web app (dev)`,
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        compress: true,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(`${api.apiId}.execute-api.${REGION}.amazonaws.com`, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          functionAssociations: [
            { function: stripApiPrefix, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    // ------------------------------------------------------------------
    // Alarms — minimal, always-free.
    // ------------------------------------------------------------------
    new cloudwatch.Alarm(this, 'WorkerErrors', {
      alarmName: `${PROJECT}-worker-errors`,
      alarmDescription: 'WorkerFunction errors > 3 in 5 minutes',
      metric: workerFn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'sum' }),
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'DlqDepth', {
      alarmName: `${PROJECT}-feed-jobs-dlq-depth`,
      alarmDescription: 'Any visible message in the feed-jobs DLQ needs review',
      metric: dlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'max',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', { value: defaultStage.url });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'DistributionDomainName', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'WebBucketName', { value: webBucket.bucketName });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'QueueUrl', { value: queue.queueUrl });
    new cdk.CfnOutput(this, 'DeployRoleArn', { value: props.deployRoleArn });
  }
}
