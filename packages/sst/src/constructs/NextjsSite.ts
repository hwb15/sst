import fs from "fs";
import path from "path";
import { Construct } from "constructs";
import { Fn, Duration as CdkDuration, RemovalPolicy } from "aws-cdk-lib/core";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  CfnFunction,
  Code,
  Runtime,
  Architecture,
  Function as CdkFunction,
  FunctionUrlAuthType,
  FunctionProps,
} from "aws-cdk-lib/aws-lambda";
import {
  ViewerProtocolPolicy,
  AllowedMethods,
  BehaviorOptions,
  CachedMethods,
  LambdaEdgeEventType,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { Stack } from "./Stack.js";
import { Distribution } from "./Distribution.js";
import { SsrFunction } from "./SsrFunction.js";
import { EdgeFunction } from "./EdgeFunction.js";
import { SsrSite, SsrSiteProps } from "./SsrSite.js";
import { Size, toCdkSize } from "./util/size.js";

function pathPattern(basePath = '') {
  return (pattern: string) =>
    basePath && basePath.length > 0 ? `${basePath}${pattern}` : pattern;
}

export interface NextjsSiteProps extends Omit<SsrSiteProps, "nodejs"> {
  basePath?: string;
  imageOptimization?: {
    /**
     * The amount of memory in MB allocated for image optimization function.
     * @default 1024 MB
     * @example
     * ```js
     * memorySize: "512 MB",
     * ```
     */
    memorySize?: number | Size;
  };
  cdk?: SsrSiteProps["cdk"] & {
    revalidation?: Pick<FunctionProps, "vpc" | "vpcSubnets">;
    /**
     * Override the CloudFront cache policy properties for responses from the
     * server rendering Lambda.
     *
     * @default
     * By default, the cache policy is configured to cache all responses from
     * the server rendering Lambda based on the query-key only. If you're using
     * cookie or header based authentication, you'll need to override the
     * cache policy to cache based on those values as well.
     *
     * ```js
     * serverCachePolicy: new CachePolicy(this, "ServerCache", {
     *   queryStringBehavior: CacheQueryStringBehavior.all()
     *   headerBehavior: CacheHeaderBehavior.allowList(
     *     "accept",
     *     "rsc",
     *     "next-router-prefetch",
     *     "next-router-state-tree",
     *     "next-url",
     *   ),
     *   cookieBehavior: CacheCookieBehavior.none()
     *   defaultTtl: Duration.days(0)
     *   maxTtl: Duration.days(365)
     *   minTtl: Duration.days(0)
     * })
     * ```
     */
    serverCachePolicy?: NonNullable<SsrSiteProps["cdk"]>["serverCachePolicy"];
  };
}

/**
 * The `NextjsSite` construct is a higher level CDK construct that makes it easy to create a Next.js app.
 * @example
 * Deploys a Next.js app in the `my-next-app` directory.
 *
 * ```js
 * new NextjsSite(stack, "web", {
 *   path: "my-next-app/",
 * });
 * ```
 */
export class NextjsSite extends SsrSite {
  protected declare props: NextjsSiteProps & {
    path: Exclude<NextjsSiteProps["path"], undefined>;
    runtime: Exclude<NextjsSiteProps["runtime"], undefined>;
    timeout: Exclude<NextjsSiteProps["timeout"], undefined>;
    memorySize: Exclude<NextjsSiteProps["memorySize"], undefined>;
    waitForInvalidation: Exclude<
      NextjsSiteProps["waitForInvalidation"],
      undefined
    >;
  };

  constructor(scope: Construct, id: string, props?: NextjsSiteProps) {
    super(scope, id, {
      buildCommand: "npx --yes open-next@2.1.5 build",
      ...props,
    });

    this.deferredTaskCallbacks.push(() => {
      this.createRevalidation();
    });
  }

  protected createRevalidation() {
    if (!this.serverLambdaForRegional && !this.serverLambdaForEdge) return;

    const { cdk } = this.props;

    const queue = new Queue(this, "RevalidationQueue", {
      fifo: true,
      receiveMessageWaitTime: CdkDuration.seconds(20),
    });
    const consumer = new CdkFunction(this, "RevalidationFunction", {
      description: "Next.js revalidator",
      handler: "index.handler",
      code: Code.fromAsset(
        path.join(this.props.path, ".open-next", "revalidation-function")
      ),
      runtime: Runtime.NODEJS_18_X,
      timeout: CdkDuration.seconds(30),
      ...cdk?.revalidation,
    });
    consumer.addEventSource(new SqsEventSource(queue, { batchSize: 5 }));

    // Allow server to send messages to the queue
    const server = this.serverLambdaForRegional || this.serverLambdaForEdge;
    server?.addEnvironment("REVALIDATION_QUEUE_URL", queue.queueUrl);
    server?.addEnvironment("REVALIDATION_QUEUE_REGION", Stack.of(this).region);
    queue.grantSendMessages(server?.role!);
  }

  protected initBuildConfig() {
    return {
      typesPath: ".",
      serverBuildOutputFile: ".open-next/server-function/index.mjs",
      clientBuildOutputDir: ".open-next/assets",
      clientBuildVersionedSubDir: "_next",
      clientBuildS3KeyPrefix: "_assets",
      prerenderedBuildOutputDir: ".open-next/cache",
      prerenderedBuildS3KeyPrefix: "_cache",
      warmerFunctionAssetPath: path.join(
        this.props.path,
        ".open-next/warmer-function"
      ),
    };
  }

  protected createFunctionForRegional() {
    const {
      runtime,
      timeout,
      memorySize,
      bind,
      permissions,
      environment,
      cdk,
    } = this.props;
    return new SsrFunction(this, `ServerFunction`, {
      description: "Next.js server",
      bundle: path.join(this.props.path, ".open-next", "server-function"),
      handler: "index.handler",
      runtime,
      timeout,
      memorySize,
      bind,
      permissions,
      environment: {
        ...environment,
        CACHE_BUCKET_NAME: this.bucket.bucketName,
        CACHE_BUCKET_KEY_PREFIX: "_cache",
        CACHE_BUCKET_REGION: Stack.of(this).region,
      },
      ...cdk?.server,
    });
  }

  protected createFunctionForEdge() {
    const { runtime, timeout, memorySize, bind, permissions, environment } =
      this.props;
    return new EdgeFunction(this, "ServerFunction", {
      bundle: path.join(this.props.path, ".open-next", "server-function"),
      handler: "index.handler",
      runtime,
      timeout,
      memorySize,
      bind,
      permissions,
      environment: {
        ...environment,
        CACHE_BUCKET_NAME: this.bucket.bucketName,
        CACHE_BUCKET_KEY_PREFIX: "_cache",
        CACHE_BUCKET_REGION: Stack.of(this).region,
      },
    });
  }

  private createImageOptimizationFunction() {
    const { imageOptimization, path: sitePath } = this.props;

    const fn = new CdkFunction(this, `ImageFunction`, {
      description: "Next.js image optimizer",
      handler: "index.handler",
      currentVersionOptions: {
        removalPolicy: RemovalPolicy.DESTROY,
      },
      logRetention: RetentionDays.THREE_DAYS,
      code: Code.fromInline("export function handler() {}"),
      runtime: Runtime.NODEJS_18_X,
      memorySize: imageOptimization?.memorySize
        ? typeof imageOptimization.memorySize === "string"
          ? toCdkSize(imageOptimization.memorySize).toMebibytes()
          : imageOptimization.memorySize
        : 1536,
      timeout: CdkDuration.seconds(25),
      architecture: Architecture.ARM_64,
      environment: {
        BUCKET_NAME: this.bucket.bucketName,
        BUCKET_KEY_PREFIX: "_assets",
      },
      initialPolicy: [
        new PolicyStatement({
          actions: ["s3:GetObject"],
          resources: [this.bucket.arnForObjects("*")],
        }),
      ],
    });

    // update code after build
    this.deferredTaskCallbacks.push(() => {
      const cfnFunction = fn.node.defaultChild as CfnFunction;
      const code = Code.fromAsset(
        path.join(sitePath, ".open-next/image-optimization-function")
      );
      const codeConfig = code.bind(fn);
      cfnFunction.code = {
        s3Bucket: codeConfig.s3Location?.bucketName,
        s3Key: codeConfig.s3Location?.objectKey,
        s3ObjectVersion: codeConfig.s3Location?.objectVersion,
      };
      code.bindToResource(cfnFunction);
    });

    return fn;
  }

  protected createCloudFrontDistributionForRegional() {
    /**
     * Next.js requests
     *
     * - Public asset
     *  Use case: When you request an asset in /public
     *  Request: /myImage.png
     *  Response cache:
     *  - Cache-Control: public, max-age=0, must-revalidate
     *  - x-vercel-cache: MISS (1st request)
     *  - x-vercel-cache: HIT (2nd request)
     *
     * - SSG page
     *  Use case: When you request an SSG page directly
     *  Request: /myPage
     *  Response cache:
     *  - Cache-Control: public, max-age=0, must-revalidate
     *  - Content-Encoding: br
     *  - x-vercel-cache: HIT (2nd request, not set for 1st request)
     *
     * - SSR page (directly)
     *  Use case: When you request an SSR page directly
     *  Request: /myPage
     *  Response cache:
     *  - Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate
     *  - x-vercel-cache: MISS
     *
     * - SSR pages (user transition)
     *  Use case: When the page uses getServerSideProps(), and you request this page on
     *            client-side page trasitions. Next.js sends an API request to the server,
     *            which runs getServerSideProps()
     *  Request: /_next/data/_-fpIB1rqWyRD-EJO59pO/myPage.json
     *  Response cache:
     *  - Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate
     *  - x-vercel-cache: MISS
     *
     * - Image optimization
     *  Use case: when you request an image
     *  Request: /_next/image?url=%2F_next%2Fstatic%2Fmedia%2F4600x4600.ce39e3d6.jpg&w=256&q=75
     *  Response cache:
     *    - Cache-Control: public, max-age=31536000, immutable
     *    - x-vercel-cache: HIT
     *
     * - API
     *  Use case: when you request an API endpoint
     *  Request: /api/hello
     *  Response cache:
     *    - Cache-Control: public, max-age=0, must-revalidate
     *    - x-vercel-cache: MISS
     */

    const { customDomain, cdk, basePath = "" } = this.props;
    const cfDistributionProps = cdk?.distribution || {};
    const serverBehavior = this.buildDefaultBehaviorForRegional();

    const normalizedPath = pathPattern(basePath);

    return new Distribution(this, "CDN", {
      scopeOverride: this,
      customDomain,
      cdk: {
        distribution: {
          // these values can be overwritten by cfDistributionProps
          defaultRootObject: "",
          // Override props.
          ...cfDistributionProps,
          // these values can NOT be overwritten by cfDistributionProps
          defaultBehavior: serverBehavior,
          additionalBehaviors: {
            [normalizedPath('/api/*')]: serverBehavior,
            [normalizedPath("_next/data/*")]: serverBehavior,
            [normalizedPath("_next/image*")]: this.buildImageBehavior(),
            ...(cfDistributionProps.additionalBehaviors || {}),
          },
        },
      },
    });
  }

  protected createCloudFrontDistributionForEdge() {
    const { customDomain, cdk } = this.props;
    const cfDistributionProps = cdk?.distribution || {};
    const serverBehavior = this.buildDefaultBehaviorForEdge();

    return new Distribution(this, "CDN", {
      scopeOverride: this,
      customDomain,
      cdk: {
        distribution: {
          // these values can be overwritten by cfDistributionProps
          defaultRootObject: "",
          // Override props.
          ...cfDistributionProps,
          // these values can NOT be overwritten by cfDistributionProps
          defaultBehavior: serverBehavior,
          additionalBehaviors: {
            "api/*": serverBehavior,
            "_next/data/*": serverBehavior,
            "_next/image*": this.buildImageBehavior(),
            ...(cfDistributionProps.additionalBehaviors || {}),
          },
        },
      },
    });
  }

  protected useServerBehaviorCachePolicy() {
    return super.useServerBehaviorCachePolicy([
      "accept",
      "rsc",
      "next-router-prefetch",
      "next-router-state-tree",
      "next-url",
    ]);
  }

  private buildImageBehavior(): BehaviorOptions {
    const { cdk, regional } = this.props;
    const imageFn = this.createImageOptimizationFunction();
    const imageFnUrl = imageFn.addFunctionUrl({
      authType: regional?.enableServerUrlIamAuth
        ? FunctionUrlAuthType.AWS_IAM
        : FunctionUrlAuthType.NONE,
    });

    return {
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      origin: new HttpOrigin(Fn.parseDomainName(imageFnUrl.url)),
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
      compress: true,
      cachePolicy:
        cdk?.serverCachePolicy ?? this.useServerBehaviorCachePolicy(),
      responseHeadersPolicy: cdk?.responseHeadersPolicy,
      edgeLambdas: regional?.enableServerUrlIamAuth
        ? [
            (() => {
              const fn = this.useServerUrlSigningFunction();
              fn.attachPermissions([
                new PolicyStatement({
                  actions: ["lambda:InvokeFunctionUrl"],
                  resources: [imageFn.functionArn],
                }),
              ]);
              return {
                includeBody: true,
                eventType: LambdaEdgeEventType.ORIGIN_REQUEST,
                functionVersion: fn.currentVersion,
              };
            })(),
          ]
        : [],
    };
  }

  protected generateBuildId(): string {
    const filePath = path.join(this.props.path, ".next/BUILD_ID");
    return fs.readFileSync(filePath).toString();
  }

  public getConstructMetadata() {
    return {
      type: "NextjsSite" as const,
      ...this.getConstructMetadataBase(),
    };
  }
}
