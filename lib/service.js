const { _ } = require('@feathersjs/commons');
const { AdapterService, select } = require('@feathersjs/adapter-commons');
const errors = require('@feathersjs/errors');

const errorHandler = require('./error-handler');

// Create the service.
class Service extends AdapterService {
  constructor (options) {
    if (!options.Model || !options.Model.modelName) {
      throw new Error('You must provide a Mongoose Model');
    }

    super(Object.assign({
      id: '_id',
      whitelist: ['$regex']
    }, options));

    this.discriminatorKey = this.Model.schema.options.discriminatorKey;
    this.discriminators = {};
    
    (options.discriminators || []).forEach(element => {
      if (element.modelName) {
        this.discriminators[element.modelName] = element;
      }
    });
    this.lean = options.lean === undefined ? true : options.lean;
    this.overwrite = options.overwrite !== false;
    this.useEstimatedDocumentCount = !!options.useEstimatedDocumentCount;
  }

  get Model () {
    return this.options.Model;
  }

  _getOrFind (id, params) {
    if (id === null) {
      return this._find(params);
    }

    return this._get(id, params);
  }

  _find (params) {
    const { filters, query, paginate } = this.filterQuery(params);
    const discriminator = (params.query || {})[this.discriminatorKey] || this.discriminatorKey;
    const model = this.discriminators[discriminator] || this.Model;
    const q = model.find(_.omit(query, '$populate')).lean(this.lean);

    // $select uses a specific find syntax, so it has to come first.
    if (Array.isArray(filters.$select)) {
      q.select(filters.$select.reduce((res, key) => Object.assign(res, {
        [key]: 1
      }), {}));
    } else if (typeof filters.$select === 'string' || typeof filters.$select === 'object') {
      q.select(filters.$select);
    }

    // Handle $sort
    if (filters.$sort) {
      q.sort(filters.$sort);
    }

    // Handle collation
    if (params.collation) {
      q.collation(params.collation);
    }

    // Handle $limit
    if (typeof filters.$limit !== 'undefined') {
      q.limit(filters.$limit);
    }

    // Handle $skip
    if (filters.$skip) {
      q.skip(filters.$skip);
    }

    // Handle $populate
    if (query.$populate) {
      q.populate(query.$populate);
    }

    let executeQuery = total => q.exec().then(data => {
      return {
        total,
        limit: filters.$limit,
        skip: filters.$skip || 0,
        data
      };
    });

    if (filters.$limit === 0) {
      executeQuery = total => Promise.resolve({
        total,
        limit: filters.$limit,
        skip: filters.$skip || 0,
        data: []
      });
    }

    if (paginate && paginate.default) {
      return model.where(query)[this.useEstimatedDocumentCount ? 'estimatedDocumentCount' : 'countDocuments']().exec().then(executeQuery);
    }

    return executeQuery().then(page => page.data);
  }

  _get (id, params = {}) {
    const { query, filters } = this.filterQuery(params);

    query[this.id] = id;

    const discriminator = query[this.discriminatorKey] || this.discriminatorKey;
    const model = this.discriminators[discriminator] || this.Model;
    let modelQuery = model.findOne(_.omit(query, '$populate'));

    // Handle $populate
    if (query.$populate) {
      modelQuery = modelQuery.populate(query.$populate);
    }

    // Handle $select
    if (filters.$select && filters.$select.length) {
      let fields = { [this.id]: 1 };

      for (let key of filters.$select) {
        fields[key] = 1;
      }

      modelQuery.select(fields);
    } else if (filters.$select && typeof filters.$select === 'object') {
      modelQuery.select(filters.$select);
    }

    return modelQuery.lean(this.lean).exec().then(data => {
      if (!data) {
        throw new errors.NotFound(`No record found for id '${id}'`);
      }

      return data;
    }).catch(errorHandler);
  }

  _create (data, params) {
    const discriminator = (params.query || {})[this.discriminatorKey] || this.discriminatorKey;
    const model = this.discriminators[discriminator] || this.Model;
    return model.create(data).then(result => {
      if (this.lean) {
        if (Array.isArray(result)) {
          return result.map(item => (item.toObject ? item.toObject() : item));
        }
        return result.toObject ? result.toObject() : result;
      }
      return result;
    }).then(select(params, this.id)).catch(errorHandler);
  }

  _update (id, data, params) {
    if (id === null) {
      return Promise.reject(new errors.BadRequest('Not replacing multiple records. Did you mean `patch`?'));
    }

    // Handle case where data might be a mongoose model
    if (typeof data.toObject === 'function') {
      data = data.toObject();
    }

    const { query } = this.filterQuery(params);
    const options = Object.assign({
      new: true,
      overwrite: this.overwrite,
      runValidators: true,
      context: 'query',
      setDefaultsOnInsert: true
    }, params.mongoose);

    query[this.id] = id;

    if (this.id === '_id') {
      // We can not update default mongo ids
      data = _.omit(data, this.id);
    } else {
      // If not using the default Mongo _id field set the id to its
      // previous value. This prevents orphaned documents.
      data = Object.assign({}, data, { [this.id]: id });
    }

    const discriminator = query[this.discriminatorKey] || this.discriminatorKey;
    const model = this.discriminators[discriminator] || this.Model;
    let modelQuery = model.findOneAndUpdate(_.omit(query, '$populate'), data, options);

    if (query.$populate) {
      modelQuery = modelQuery.populate(query.$populate);
    }

    return modelQuery.lean(this.lean).exec()
      .then(result => {
        if (result === null) {
          throw new errors.NotFound(`No record found for id '${id}'`);
        }

        return result;
      })
      .then(select(params, this.id)).catch(errorHandler);
  }

  _patch (id, data, params) {
    const { query } = this.filterQuery(params);
    const mapIds = data => data.map(current => current[this.id]);

    // By default we will just query for the one id. For multi patch
    // we create a list of the ids of all items that will be changed
    // to re-query them after the update
    const ids = id === null ? this._find(params)
      .then(mapIds) : Promise.resolve([ id ]);

    // Handle case where data might be a mongoose model
    if (typeof data.toObject === 'function') {
      data = data.toObject();
    }

    // ensure we are working on a copy
    data = Object.assign({}, data);

    // If we are updating multiple records
    let options = Object.assign({
      multi: id === null,
      runValidators: true,
      context: 'query'
    }, params.mongoose);

    if (id !== null) {
      query[this.id] = id;
    }

    if (this.id === '_id') {
      // We can not update default mongo ids
      delete data[this.id];
    } else if (id !== null) {
      // If not using the default Mongo _id field set the id to its
      // previous value. This prevents orphaned documents.
      data[this.id] = id;
    }

    // NOTE (EK): We need this shitty hack because update doesn't
    // return a promise properly when runValidators is true. WTF!
    try {
      return ids.then(idList => {
        // Create a new query that re-queries all ids that
        // were originally changed
        const findParams = idList.length ? Object.assign({}, params, {
          paginate: false,
          query: Object.assign({
            [this.id]: { $in: idList }
          }, query)
        }) : Object.assign({}, params, {
          paginate: false
        });

        // If params.query.$populate was provided, remove it
        // from the query sent to mongoose.
        const discriminator = query[this.discriminatorKey] || this.discriminatorKey;
        const model = this.discriminators[discriminator] || this.Model;
        return model
          .updateMany(_.omit(query, '$populate'), data, options)
          .lean(this.lean)
          .exec()
          .then(writeResult => {
            if (options.writeResult) {
              return writeResult;
            }
            return this._getOrFind(id, findParams);
          });
      }).then(select(params, this.id)).catch(errorHandler);
    } catch (e) {
      return errorHandler(e);
    }
  }

  _remove (id, params) {
    const { query } = this.filterQuery(params);

    if (params.collation) {
      query.collation = params.collation;
    }

    if (id !== null) {
      query[this.id] = id;

      return this.Model.findOneAndDelete(query).lean(this.lean)
        .exec().then(result => {
          if (result === null) {
            throw new errors.NotFound(`No record found for id '${id}'`, query);
          }

          return result;
        }).then(select(params, this.id)).catch(errorHandler);
    }

    const findParams = Object.assign({}, params, {
      paginate: false,
      query
    });

    // NOTE (EK): First fetch the record(s) so that we can return
    // it/them when we delete it/them.
    return this._getOrFind(id, findParams).then(data =>
      this.Model.deleteMany(query)
        .lean(this.lean)
        .exec()
        .then(() => data)
        .then(select(params, this.id))
    ).catch(errorHandler);
  }
}

module.exports = function init (options) {
  return new Service(options);
};

module.exports.Service = Service;
