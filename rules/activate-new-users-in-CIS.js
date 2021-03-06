function (user, context, callback) {
  const AUTH0_TIMEOUT = 5000;  // milliseconds
  const CHANGEAPI_TIMEOUT = 14000;  // milliseconds
  const METADATA = context.primaryUserMetadata || user.user_metadata || {};  // linked account, or if not linked, then user
  const PERSONAPI_BEARER_TOKEN_REFRESH_AGE = 64800;  // 18 hours
  const PERSONAPI_TIMEOUT = 5000;  // milliseconds
  const PUBLISHER_NAME = 'access_provider';
  const USER_ID = context.primaryUser || user.user_id;  // linked account, or if not linked, then the user account
  const WHITELISTED_CONNECTIONS = ['email', 'firefoxaccounts', 'github', 'google-oauth2', 'oauth2'];

  // if we don't have the configuration variables we need, bail
  // note that this requires the "PersonAPI - Auth0" application configured with the following scopes:
  // classification: public, display: none, display: public, write
  if (!configuration.changeapi_auth0_private_key ||
      !configuration.changeapi_null_profile ||
      !configuration.changeapi_url ||
      !configuration.personapi_client_id ||
      !configuration.personapi_client_secret ||
      !configuration.personapi_url) {
    console.log('Error: Unable to find PersonAPI and/or ChangeAPI configuration');
    return callback(null, user, context);
  }

  // the `personapi_url` and `personapi_audience` variables have historically been configured incorrectly,
  // so we don't continue onward unless they have been fixed, e.g.:
  // personapi_audience: api.dev.sso.allizom.org / api.sso.mozilla.com
  // personapi_url: https://person.api.dev.sso.allizom.org / https://person.api.sso.mozilla.com
  if (configuration.personapi_audience.includes('https') || configuration.personapi_url.includes('/v')) {
    console.log('Error: PersonAPI configured incorrectly');
    return callback(null, user, context);
  }

  // We can only provision users that have certain connection strategies
  if (!WHITELISTED_CONNECTIONS.includes(context.connectionStrategy)) {
    return callback(null, user, context);
  }

  // if you're explicitly flagged as existing in CIS, then we don't need to continue onward
  if (METADATA.existsInCIS) {
    return callback(null, user, context);
  }

  // we'll need the node-fetch module, to add support for timeouts
  const fetch = require('node-fetch@2.6.0');

  // we also need to decode the private key from base64 into a PEM format that `jsonwebtoken` understands
  // generated with:
  // import base64
  // import boto3
  // base64.b64encode(boto3.client('ssm').get_parameter(Name='/iam/cis/development/keys/access_provider', WithDecryption=True)['Parameter']['Value'].encode('ascii')).decode('ascii')
  const privateKey = Buffer.from(configuration.changeapi_auth0_private_key, 'base64');

  const getBearerToken = async () => {
    // if we have the bearer token stored, we don't need to fetch it again
    if (global.personapi_bearer_token &&
        global.personapi_bearer_token_creation_time &&
        Date.now() - global.personapi_bearer_token_creation_time < PERSONAPI_BEARER_TOKEN_REFRESH_AGE) {
      return global.personapi_bearer_token;
    }

    console.log('Retrieving bearer token to create new user in CIS');

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: AUTH0_TIMEOUT,
      body: JSON.stringify({
        audience: configuration.personapi_audience,
        client_id: configuration.personapi_client_id,
        client_secret: configuration.personapi_client_secret,
        grant_type: 'client_credentials',
      })
    };

    try {
      const response = await fetch(configuration.personapi_oauth_url, options);
      const data = await response.json();

      // store the bearer token in the global object, so it's not constantly retrieved
      global.personapi_bearer_token = data.access_token;
      global.personapi_bearer_token_creation_time = Date.now();

      console.log(`Successfully retrieved bearer token from Auth0`);
      return global.personapi_bearer_token;
    } catch (error) {
      throw Error(`Unable to retrieve bearer token from Auth0: ${error.message}`);
    }
  };

  const createPersonProfile = async () => {
    console.log(`Generating CIS profile for ${USER_ID}`);

    let now = new Date();
    now = now.toISOString();

    // load the user skeleton, as generated by:
    // base64.b64encode(json.dumps(requests.get('https://raw.githubusercontent.com/mozilla-iam/cis/master/python-modules/cis_profile/cis_profile/data/user_profile_null.json').json(), separators=(',', ':')).encode('ascii'))
    const profile = JSON.parse(Buffer.from(configuration.changeapi_null_profile, 'base64'));

    // update attributes in the skeleton
    // normally we shouldn't need to change anything but the values, but this is manually doing it because
    // I have no idea if the skeleton will ever change underneath me
    profile.active.metadata.last_modified = now;
    profile.active.signature.publisher.name = PUBLISHER_NAME;
    profile.active.value = true;

    // order goes given_name -> name -> family_name -> nickname -> ' '
    profile.first_name.metadata.display = 'private';
    profile.first_name.metadata.last_modified = now;
    profile.first_name.signature.publisher.name = PUBLISHER_NAME;
    profile.first_name.value = user.given_name || user.name || user.family_name || user.nickname || ' ';

    profile.last_name.metadata.display = 'private';
    profile.last_name.metadata.last_modified = now;
    profile.last_name.signature.publisher.name = PUBLISHER_NAME;
    profile.last_name.value = user.family_name ? user.family_name : ' ';

    profile.primary_email.metadata.last_modified = now;
    profile.primary_email.signature.publisher.name = PUBLISHER_NAME;
    profile.primary_email.value = user.email;

    profile.user_id.metadata.last_modified = now;
    profile.user_id.signature.publisher.name = PUBLISHER_NAME;
    profile.user_id.value = USER_ID;

    // now we need to go and update the identities values; this is based on the logic here:
    // https://github.com/mozilla-iam/cis/blob/master/python-modules/cis_publisher/cis_publisher/auth0.py
    // which may or may not be correct, I dunno
    for (let i = 0; i < user.identities.length; i++) {
      const identity = user.identities[i];
      // ignore a provider if it's not whitelisted
      if (!WHITELISTED_CONNECTIONS.includes(identity.connection)) {
        continue;
      }

      // store the login_method for the first identity
      if (i === 0) {
        profile.login_method.metadata.last_modified = now;
        profile.login_method.signature.publisher.name = PUBLISHER_NAME;
        profile.login_method.value = identity.connection;
      }

      if (identity.provider === 'github') {
        profile.identities.github_id_v3.metadata.display = 'private';
        profile.identities.github_id_v3.metadata.last_modified = now;
        profile.identities.github_id_v3.signature.publisher.name = PUBLISHER_NAME;
        profile.identities.github_id_v3.value = identity.user_id;

        if (user.nickname) {
          profile.usernames.metadata.display = 'private';
          profile.usernames.signature.publisher.name = PUBLISHER_NAME;
          profile.usernames.values = {"HACK#GITHUB": user.nickname};
        }

        if (identity.profileData) {
          // I could never seem to find a user that met this condition
          profile.identities.github_id_v4.metadata.display = 'private';
          profile.identities.github_id_v4.metadata.last_modified = now;
          profile.identities.github_id_v4.signature.publisher.name = PUBLISHER_NAME;
          profile.identities.github_id_v4.value = identity.profileData.node_id;

          profile.identities.github_primary_email.metadata.display = 'private';
          profile.identities.github_primary_email.metadata.last_modified = now;
          profile.identities.github_primary_email.metadata.verified = identity.profileData.email_verified === true ? true : false;
          profile.identities.github_primary_email.signature.publisher.name = PUBLISHER_NAME;
          profile.identities.github_primary_email.value = identity.profileData.email;
        }
      }

      else if (identity.provider === 'google-oauth2') {
        profile.identities.google_oauth2_id.metadata.display = 'private';
        profile.identities.google_oauth2_id.metadata.last_modified = now;
        profile.identities.google_oauth2_id.signature.publisher.name = PUBLISHER_NAME;
        profile.identities.google_oauth2_id.value = identity.user_id;

        profile.identities.google_primary_email.metadata.display = 'private';
        profile.identities.google_primary_email.metadata.last_modified = now;
        profile.identities.google_primary_email.signature.publisher.name = PUBLISHER_NAME;
        profile.identities.google_primary_email.value = user.email;
      }

      else if (identity.connection === 'firefoxaccounts' && identity.provider === 'oauth2') {
        profile.identities.firefox_accounts_id.metadata.display = 'private';
        profile.identities.firefox_accounts_id.metadata.last_modified = now;
        profile.identities.firefox_accounts_id.signature.publisher.name = PUBLISHER_NAME;
        profile.identities.firefox_accounts_id.value = identity.user_id;

        profile.identities.firefox_accounts_primary_email.metadata.display = 'private';
        profile.identities.firefox_accounts_primary_email.metadata.last_modified = now;
        profile.identities.firefox_accounts_primary_email.signature.publisher.name = PUBLISHER_NAME;
        profile.identities.firefox_accounts_primary_email.value = user.email;
      }
    }

    // now, we need to sign every field and subfield
    signAll(profile);

    // turn this on only for debugging
    // console.log(`Generated profile:\n${JSON.stringify(profile, null, 2)}`);
    return profile;
  };

  const getPersonProfile = async () => {
    const bearer = await getBearerToken();
    const options = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${bearer}`,
      },
      timeout: PERSONAPI_TIMEOUT,
    };
    const url = `${configuration.personapi_url}/v2/user/user_id/${encodeURI(USER_ID)}?active=any`;

    console.log(`Fetching person profile of ${USER_ID}`);

    const response = await fetch(url, options);

    return response.json();
  };

  const postProfile = async profile => {
    console.log(`Posting profile for ${USER_ID} to ChangeAPI`);

    const bearer = await getBearerToken();
    const options = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(profile),
      timeout: CHANGEAPI_TIMEOUT,
    };
    const url = `${configuration.changeapi_url}/v2/user?user_id=${encodeURI(USER_ID)}`;

    // POST the profile to the ChangeAPI
    const response = await fetch(url, options);

    return response.json();
  };

  const signAll = profile => {
    // now we need to sign every attribute in the profile, if we're allowed to
    // otherwise, we will descend one level deep for sub attributes
    // this is super hacky and ugly and I hate it
    Object.values(profile).forEach(attr => {  // works because profile is mutable
      if (attr.constructor === Object && attr.signature) {
        signAttribute(attr);
      } else if (attr.constructor === Object && !attr.signature) {
        signAll(attr);  // descend deeper
      }
    });
  };

  const signAttribute = attr => {
    const jwt = require('jsonwebtoken');

    // we can only sign attributes that access_provider (e.g. auth0) is allowed to sign
    // we also ignore things that don't have a pre-existing signature field
    // we also don't need to sign null attributes
    if (!attr.signature || attr.signature.publisher.name !== PUBLISHER_NAME || attr.value === null || attr.values === null) {
      return attr;
    }

    // this is an ugly hack, as the CIS profile currently requires all integers to be cast into strings
    if (attr.value && typeof attr.value === "number") {
      attr.value = attr.value.toString();
    }

    // we need to delete the existing signature and generate it anew
    delete(attr.signature);

    attr.signature = {
      additional: [{
        alg: 'RS256',
        name: null,
        typ: 'JWS',
        value: '',
      }],
      publisher: {
        alg: 'RS256',
        name: PUBLISHER_NAME,
        typ: 'JWS',
        value: jwt.sign(attr, privateKey, { algorithm: 'RS256', noTimestamp: true }),
      }
    };

    return attr;
  };

  const setExistsInCIS = (exists = true) => {
    // update user metadata to store them existing
    METADATA.existsInCIS = exists;

    auth0.users.updateUserMetadata(USER_ID, METADATA)
      .then(() => {
        console.log(`Updated user metadata on ${USER_ID} to set existsInCIS`);
        return exists;
      })
      .catch(() => {
        throw Error(`Unable to set existsInCIS on ${USER_ID}`);
      });
  };

  // if we get this far, we need to 1) call the PersonAPI to check for existance, and 2) if the user
  // doesn't exist, call the ChangeAPI to create them
  getPersonProfile()
    .then(profile => {
      if (Object.keys(profile).length !== 0) {
        setExistsInCIS();
        throw Error(`Profile for ${user.user_id} already exists in PersonAPI as ${USER_ID}`);
      } else {
        return createPersonProfile();
      }
    })
    .then(profile => postProfile(profile))
    .then(response => {
      if (response.constructor === Object && response.status_code === 200) {
        console.log(`Successfully created profile for ${user.user_id} in ChangeAPI as ${USER_ID}`);

        // set their profile as existing in CIS
        setExistsInCIS();

        return callback(null, user, context);
      } else {
        throw Error(`Unable to create profile for ${USER_ID} in ChangeAPI`);
      }
    })
    .catch(error => {
      console.log(`Error: ${error.message}`);
      return callback(null, user, context);
    });
}
