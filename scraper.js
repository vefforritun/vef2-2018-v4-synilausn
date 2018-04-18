require('dotenv').config();
require('isomorphic-fetch');

const cheerio = require('cheerio');
const redis = require('redis');
const util = require('util');

const {
  REDIS_URL,
  REDIS_EXPIRE,
  REDIS_PREFIX: redisPrefix = 'proftafla',
} = process.env;

const redisOptions = {
  url: REDIS_URL,
};

const client = redis.createClient(redisOptions);

const asyncGet = util.promisify(client.get).bind(client);
const asyncSet = util.promisify(client.set).bind(client);
const asyncKeys = util.promisify(client.keys).bind(client);
const asyncDel = util.promisify(client.del).bind(client);

/**
 * Listi af sviðum með „slug“ fyrir vefþjónustu og viðbættum upplýsingum til
 * að geta sótt gögn.
 */
const schools = [
  {
    name: 'Félagsvísindasvið',
    id: 1,
    slug: 'felagsvisindasvid',
  },
  {
    name: 'Heilbrigðisvísindasvið',
    id: 2,
    slug: 'heilbrigdisvisindasvid',
  },
  {
    name: 'Hugvísindasvið',
    id: 3,
    slug: 'hugvisindasvid',
  },
  {
    name: 'Menntavísindasvið',
    id: 4,
    slug: 'menntavisindasvid',
  },
  {
    name: 'Verkfræði- og náttúruvísindasvið',
    id: 5,
    slug: 'verkfraedi-og-natturuvisindasvid',
  },
];

/**
 * Sækir gögn úr cache eftir `key`.
 *
 * @param key - Lykill til að sækja eftir
 * @returns {Promise} - Promise fyrir object úr cache eða null ef engin
 */
async function getFromCache(key) {
  try {
    const result = await asyncGet(key);
    return JSON.parse(result);
  } catch (error) {
    console.warn(`Unable to get key ${key} from cache`, error);
  }
  return null;
}

/**
 * Geymir gögn í `value` í cache undir `key`
 *
 * @param key - Lykill til að geyma gögn undir
 * @param value - Gildi til að geyma
 */
async function cache(key, value) {
  const ttl = REDIS_EXPIRE;

  try {
    await asyncSet(key, JSON.stringify(value), 'EX', ttl);
  } catch (error) {
    console.warn(`Unable to set cache for key ${key}`, error);
  }
}

/**
 * Sækir og vinnur gögn fyrir svið.
 *
 * @param {number} id - Id á sviði í Uglu
 * @returns {Promise} - Promise sem mun innihalda fylki af sviðum með deildum og prófum
 */
async function fetchAndParse(id, heading) {
  const url = `https://ugla.hi.is/Proftafla/View/ajax.php?sid=2027&a=getProfSvids&proftaflaID=37&svidID=${id}&notaVinnuToflu=0`;

  const result = await fetch(url);

  if (result.status !== 200) {
    throw new Error('Non 200 status from url');
  }

  const json = await result.json();

  const data = json.html;

  const $ = cheerio.load(data);
  const departmentHeadings = $('h3');

  const departments = [];

  departmentHeadings.each((i, el) => {
    const departmentHeading = $(el).text().trim();

    const rows = $(el).next('table').find('tbody tr');
    const tests = [];
    rows.each((j, row) => {
      const course = $(row).find('td:nth-child(1)').text().trim();
      const name = $(row).find('td:nth-child(2)').text().trim();
      const type = $(row).find('td:nth-child(3)').text().trim();
      const students = $(row).find('td:nth-child(4)').text().trim();
      const date = $(row).find('td:nth-child(5)').text().trim();

      tests.push({
        course,
        name,
        type,
        students: Number(students),
        date,
      });
    });

    departments.push({
      heading: departmentHeading,
      tests,
    });
  });

  return { heading, departments };
}

/**
 * Sækir svið eftir `slug`. Fáum gögn annaðhvort beint frá vef eða úr cache.
 *
 * @param {string} slug - Slug fyrir svið sem skal sækja
 * @returns {Promise} Promise sem mun innihalda gögn fyrir svið eða null ef það finnst ekki
 */
async function getTests(slug) {
  const item = schools.find(i => i.slug === slug);

  if (!item) {
    return null;
  }

  const key = `${redisPrefix}:${slug}`;
  const cached = await getFromCache(key);

  if (cached) {
    return cached;
  }

  const data = await fetchAndParse(item.id, item.name);

  await cache(key, data);

  return data;
}

/**
 * Hreinsar cache.
 *
 * @returns {Promise} Promise sem mun innihalda boolean um hvort cache hafi verið hreinsað eða ekki.
 */
async function clearCache() {
  try {
    const keys = await asyncKeys(`${redisPrefix}:*`);
    await Promise.all(keys.map(key => asyncDel(key)));
  } catch (error) {
    console.warn('Unable to clear cache');
    return false;
  }

  return true;
}

/**
 * Sækir tölfræði fyrir öll próf allra deilda allra sviða.
 *
 * @returns {Promise} Promise sem mun innihalda object með tölfræði um próf
 */
async function getStats() {
  let min = 999;
  let max = 0;
  let numTests = 0;
  let numStudents = 0;

  const all = await Promise.all(schools.map(d => getTests(d.slug)));

  all.forEach((school) => {
    school.departments.forEach((department) => {
      department.tests.forEach((test) => {
        const { students } = test;

        numTests += 1;
        numStudents += students;

        if (students > max) {
          max = students;
        }

        if (students < min) {
          min = students;
        }
      });
    });
  });

  const averageStudents = (numStudents / numTests).toFixed(2);

  return {
    min,
    max,
    numTests,
    numStudents,
    averageStudents,
  };
}

module.exports = {
  schools,
  getTests,
  clearCache,
  getStats,
};
