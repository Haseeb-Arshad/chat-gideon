/**
 * Real materials for the lab, as the desk's data sources returned them on
 * 14 September 2026: World Bank population and life expectancy, and three
 * Wikidata records. Cards are drawn from them by the same code a conversation
 * uses, so the lab shows exactly what a person would see.
 */

import type { RecordMaterial, SeriesMaterial } from '../lib/cards/materials'

const fetchedAt = '2026-09-14T00:00:00.000Z'

function worldBank(key: string, code: string, name: string, unit: string, subject: string, iso3: string, iso2: string, points: Array<[number, number]>): SeriesMaterial {
  return {
    id: `worldbank:${key}:${iso3}`,
    kind: 'series',
    measure: `worldbank:${key}`,
    name,
    subject,
    unit,
    points: points.map(([year, value]) => ({ x: String(year), value })),
    source: { title: 'World Bank', url: `https://data.worldbank.org/indicator/${code}?locations=${iso2}`, fetchedAt },
  }
}

export const POPULATION_JPN = worldBank('population', 'SP.POP.TOTL', 'Population', '', 'Japan', 'JPN', 'JP', [[1960,93216000],[1961,94055000],[1962,94933000],[1963,95900000],[1964,96903000],[1965,97952000],[1966,98851000],[1967,99879000],[1968,101011000],[1969,102219000],[1970,103403000],[1971,105697000],[1972,107188000],[1973,108707000],[1974,110162000],[1975,111573000],[1976,112775000],[1977,113872000],[1978,114913000],[1979,115890000],[1980,116807000],[1981,117661000],[1982,118480000],[1983,119307000],[1984,120083000],[1985,120837000],[1986,121482000],[1987,122069000],[1988,122578000],[1989,123069000],[1990,123478000],[1991,123964000],[1992,124425000],[1993,124829000],[1994,125178000],[1995,125472000],[1996,125757000],[1997,126057000],[1998,126400000],[1999,126631000],[2000,126843000],[2001,127149000],[2002,127445000],[2003,127718000],[2004,127761000],[2005,127773000],[2006,127854000],[2007,128001000],[2008,128063000],[2009,128047000],[2010,128070000],[2011,127833000],[2012,127629000],[2013,127445000],[2014,127276000],[2015,127141000],[2016,127076000],[2017,126972000],[2018,126811000],[2019,126633000],[2020,126261000],[2021,125681593],[2022,125124989],[2023,124516650],[2024,123975371],[2025,123366734]])

export const POPULATION_KOR = worldBank('population', 'SP.POP.TOTL', 'Population', '', 'South Korea', 'KOR', 'KR', [[1960,25012374],[1961,25765673],[1962,26513030],[1963,27261747],[1964,27984155],[1965,28704674],[1966,29435571],[1967,30130983],[1968,30838302],[1969,31544266],[1970,32240827],[1971,32882704],[1972,33505406],[1973,34103149],[1974,34692266],[1975,35280725],[1976,35848523],[1977,36411795],[1978,36969185],[1979,37534236],[1980,38123775],[1981,38723248],[1982,39326352],[1983,39910403],[1984,40405956],[1985,40805744],[1986,41213674],[1987,41621690],[1988,42031247],[1989,42449038],[1990,42869283],[1991,43295704],[1992,43747962],[1993,44194628],[1994,44641540],[1995,45092991],[1996,45524681],[1997,45953580],[1998,46286503],[1999,46616677],[2000,47008111],[2001,47370164],[2002,47644736],[2003,47892330],[2004,48082519],[2005,48184561],[2006,48438292],[2007,48683638],[2008,49054708],[2009,49307835],[2010,49554112],[2011,49936638],[2012,50199853],[2013,50428893],[2014,50746659],[2015,51014947],[2016,51217803],[2017,51361911],[2018,51585058],[2019,51764822],[2020,51836239],[2021,51769539],[2022,51672569],[2023,51712619],[2024,51751065],[2025,51684564]])

export const POPULATION_CHN = worldBank('population', 'SP.POP.TOTL', 'Population', '', 'China', 'CHN', 'CN', [[1960,667070000],[1961,660330000],[1962,665770000],[1963,682335000],[1964,698355000],[1965,715185000],[1966,735400000],[1967,754550000],[1968,774510000],[1969,796025000],[1970,818315000],[1971,841105000],[1972,862030000],[1973,881940000],[1974,900350000],[1975,916395000],[1976,930685000],[1977,943455000],[1978,956165000],[1979,969005000],[1980,981235000],[1981,993885000],[1982,1008630000],[1983,1023310000],[1984,1036825000],[1985,1051040000],[1986,1066790000],[1987,1084035000],[1988,1101630000],[1989,1118650000],[1990,1135185000],[1991,1150780000],[1992,1164970000],[1993,1178440000],[1994,1191835000],[1995,1204855000],[1996,1217550000],[1997,1230075000],[1998,1241935000],[1999,1252735000],[2000,1262645000],[2001,1271850000],[2002,1280400000],[2003,1288400000],[2004,1296075000],[2005,1303720000],[2006,1311020000],[2007,1317885000],[2008,1324655000],[2009,1331260000],[2010,1337705000],[2011,1345035000],[2012,1354190000],[2013,1363240000],[2014,1371860000],[2015,1379860000],[2016,1387790000],[2017,1396215000],[2018,1402760000],[2019,1407745000],[2020,1411100000],[2021,1412360000],[2022,1412175000],[2023,1410710000],[2024,1408975000],[2025,1406585000]])

export const LIFE_EXPECTANCY_JPN = worldBank('life_expectancy', 'SP.DYN.LE00.IN', 'Life expectancy at birth', 'years', 'Japan', 'JPN', 'JP', [[1960,67.7],[1961,68.4],[1962,68.6],[1963,69.7],[1964,70.2],[1965,70.3],[1966,70.9],[1967,71.5],[1968,71.6],[1969,71.9],[1970,71.9],[1971,72.8],[1972,73.2],[1973,73.3],[1974,73.7],[1975,74.2],[1976,74.7],[1977,75.3],[1978,75.6],[1979,76.1],[1980,76],[1981,76.4],[1982,76.9],[1983,76.9],[1984,77.3],[1985,77.6],[1986,78],[1987,78.4],[1988,78.3],[1989,78.8],[1990,78.8],[1991,79],[1992,79.1],[1993,79.3],[1994,79.7],[1995,79.5],[1996,80.2],[1997,80.4],[1998,80.5],[1999,80.5],[2000,81.1],[2001,81.4],[2002,81.7],[2003,81.8],[2004,82],[2005,82],[2006,82.3],[2007,82.5],[2008,82.6],[2009,82.9],[2010,82.8],[2011,82.6],[2012,83.1],[2013,83.3],[2014,83.6],[2015,83.8],[2016,84],[2017,84.1],[2018,84.2],[2019,84.4],[2020,84.6],[2021,84.4],[2022,84],[2023,84],[2024,84]])

export const MARIE_CURIE: RecordMaterial = {
  "id": "wikidata:Q7186",
  "kind": "record",
  "type": "person",
  "subject": "Marie Curie",
  "description": "Polish-born French physicist and chemist (1867–1934)",
  "fields": [
    {
      "key": "born",
      "label": "Born",
      "value": "7 November 1867, Warsaw"
    },
    {
      "key": "died",
      "label": "Died",
      "value": "4 July 1934, Sancellemoz"
    },
    {
      "key": "occupation",
      "label": "Occupation",
      "value": "physicist, chemist, university teacher"
    },
    {
      "key": "known_for",
      "label": "Known for",
      "value": "Treatise on Radioactivity"
    },
    {
      "key": "awards",
      "label": "Awards",
      "value": "Nobel Prize in Chemistry, Nobel Prize in Physics, Willard Gibbs Award"
    },
    {
      "key": "educated",
      "label": "Educated at",
      "value": "Science Faculty of Paris, Flying University"
    },
    {
      "key": "spouse",
      "label": "Spouse",
      "value": "Pierre Curie"
    }
  ],
  "events": [
    {
      "date": "7 November 1867",
      "sort": 18671107,
      "label": "Born in Warsaw"
    },
    {
      "date": "1903",
      "sort": 19030000,
      "label": "Nobel Prize in Physics"
    },
    {
      "date": "1911",
      "sort": 19110000,
      "label": "Nobel Prize in Chemistry"
    },
    {
      "date": "1921",
      "sort": 19210000,
      "label": "Willard Gibbs Award"
    },
    {
      "date": "4 July 1934",
      "sort": 19340704,
      "label": "Died in Sancellemoz"
    }
  ],
  "wikipedia": "Marie Curie",
  "source": {
    "title": "Wikidata",
    "url": "https://www.wikidata.org/wiki/Q7186",
    "fetchedAt": "2026-09-14T00:00:00.000Z"
  }
}

export const LISBON: RecordMaterial = {
  "id": "wikidata:Q597",
  "kind": "record",
  "type": "place",
  "subject": "Lisbon",
  "description": "municipality and capital city of Portugal",
  "fields": [
    {
      "key": "country",
      "label": "Country",
      "value": "Portugal"
    },
    {
      "key": "population",
      "label": "Population",
      "value": "545,796 (2021)"
    },
    {
      "key": "area",
      "label": "Area",
      "value": "100 km²"
    },
    {
      "key": "elevation",
      "label": "Elevation",
      "value": "100 m"
    }
  ],
  "events": [],
  "wikipedia": "Lisbon",
  "coordinates": {
    "latitude": 38.708042,
    "longitude": -9.139016
  },
  "source": {
    "title": "Wikidata",
    "url": "https://www.wikidata.org/wiki/Q597",
    "fetchedAt": "2026-09-14T00:00:00.000Z"
  }
}

export const PORTO: RecordMaterial = {
  "id": "wikidata:Q36433",
  "kind": "record",
  "type": "place",
  "subject": "Porto",
  "description": "municipality in Portugal",
  "fields": [
    {
      "key": "country",
      "label": "Country",
      "value": "Portugal"
    },
    {
      "key": "population",
      "label": "Population",
      "value": "231,800 (2021)"
    },
    {
      "key": "area",
      "label": "Area",
      "value": "41.4 km²"
    },
    {
      "key": "elevation",
      "label": "Elevation",
      "value": "104 m"
    }
  ],
  "events": [],
  "wikipedia": "Porto",
  "coordinates": {
    "latitude": 41.15,
    "longitude": -8.610833333333334
  },
  "source": {
    "title": "Wikidata",
    "url": "https://www.wikidata.org/wiki/Q36433",
    "fetchedAt": "2026-09-14T00:00:00.000Z"
  }
}
