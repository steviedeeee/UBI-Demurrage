import { ApolloServer } from 'apollo-server-lambda'
import { ApolloServerPluginLandingPageGraphQLPlayground } from 'apollo-server-core'
import { DynamoPlus } from 'dynamo-plus'
import Core from '../core/index'
import typeDefs from '../graphql/typeDefs/index'
import resolvers from '../graphql/resolvers/index'
import { CognitoUserPool } from '../cognito/userpool'
import { OfflineUserPool } from './offlineuserpool'
import { apolloLogPlugin, getLogger } from 'server-log'

const log = getLogger('lambda:handler')

const debug = process.env.DEBUG === 'true'
const offline = process.env.IS_OFFLINE === 'true'
const userpool = process.env.USER_POOL

function contextProcessor (event) {
  const { headers } = event
  // fake the cognito interface if offline
  let claims = offline
    ? JSON.parse(headers['x-claims'] || process.env.CLAIMS)
    : event.requestContext.authorizer.claims
  log.debug('User claims: %j', claims)
  return {
    ledger: claims['custom:ledger'],
    verified: claims.email_verified,
    admin: claims['custom:administrator']
  }
}
const core = Core(
  DynamoPlus({
    region: process.env.DYN_REGION,
    maxRetries: 3
  }),
  userpool
    ? CognitoUserPool(userpool)
    : OfflineUserPool()
)

log.info('Starting ApolloServer (debug: %s, offline: %s)', debug, offline)
log.debug('ENV variables: %j', process.env)
const server = new ApolloServer({
  debug,
  introspection: debug,
  typeDefs,
  resolvers,
  plugins: [apolloLogPlugin, ApolloServerPluginLandingPageGraphQLPlayground()],
  cors: false,
  context: async ({ event, context }) => {
    return {
      core,
      ...contextProcessor(event)
    }
  }
})

const handler = server.createHandler()

async function debugHandler (event, context) {
  // log.debug('event: %j', event)
  // log.debug('context: %j', context)
  return handler(event, context)
}

exports.graphqlHandler = debug ? debugHandler : handler
